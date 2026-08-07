// Windows microphone helper for pi-meta-oauth voice.
// Captures 16 kHz mono PCM via winmm.dll waveIn* and streams base64 JSON lines
// Protocol mirrors macos-audio.swift:
//   -> stdout: {"type":"ready","sampleRate":16000,"channels":1,"encoding":"pcm_s16le"}
//   -> stdout: {"type":"audio","data":"<base64 s16le>"} per captured chunk
//   -> stdout: {"type":"stopped"}
//   -> stdout: {"type":"error","message":"..."}
//   <- stdin: "stop\n" to end capture.
// Built with: csc.exe /nologo /target:exe /out:pi-meta-oauth-voice-v1.exe windows-audio.cs
//        or: dotnet build via csc.dll
// No external dependencies beyond winmm.dll and System.dll.

using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

class WinVoice
{
    // ----- winmm interop -----
    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    delegate void WaveInProc(IntPtr hwi, uint uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

    [DllImport("winmm.dll")]
    static extern int waveInGetNumDevs();

    [DllImport("winmm.dll", CharSet = CharSet.Auto)]
    static extern int waveInGetErrorText(int mmrError, StringBuilder pszText, int cchText);

    [DllImport("winmm.dll")]
    static extern int waveInOpen(out IntPtr phwi, int uDeviceID, ref WAVEFORMATEX pwfx, WaveInProc dwCallback, IntPtr dwInstance, uint fdwOpen);

    [DllImport("winmm.dll")]
    static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);

    [DllImport("winmm.dll")]
    static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);

    [DllImport("winmm.dll")]
    static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);

    [DllImport("winmm.dll")]
    static extern int waveInStart(IntPtr hwi);

    [DllImport("winmm.dll")]
    static extern int waveInStop(IntPtr hwi);

    [DllImport("winmm.dll")]
    static extern int waveInReset(IntPtr hwi);

    [DllImport("winmm.dll")]
    static extern int waveInClose(IntPtr hwi);

    const uint CALLBACK_FUNCTION = 0x00030000;
    const int WAVE_MAPPER = -1;
    const ushort WAVE_FORMAT_PCM = 1;
    const uint WIM_DATA = 0x3C0;

    const int BUFFER_BYTES = 3200; // 100 ms @ 16 kHz mono s16le
    const int BUFFER_COUNT = 3;

    static readonly object emitLock = new object();
    static WaveInProc callbackDelegate; // keep alive
    static IntPtr hWaveIn = IntPtr.Zero;
    static IntPtr[] headerPtrs = new IntPtr[BUFFER_COUNT];
    static IntPtr[] bufferPtrs = new IntPtr[BUFFER_COUNT];
    static volatile bool stopping = false;
    static volatile bool finished = false;
    static ManualResetEvent done = new ManualResetEvent(false);

    static void Emit(string type, string extraJson = null)
    {
        string line;
        if (extraJson == null) line = "{\"type\":\"" + type + "\"}";
        else line = "{\"type\":\"" + type + "\"," + extraJson + "}";
        lock (emitLock)
        {
            Console.WriteLine(line);
            Console.Out.Flush();
        }
    }

    static void EmitError(string msg)
    {
        string esc = msg.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        Emit("error", "\"message\":\"" + esc + "\"");
    }

    static string ErrorText(int code)
    {
        var sb = new StringBuilder(256);
        if (waveInGetErrorText(code, sb, sb.Capacity) == 0 && sb.Length > 0) return sb.ToString();
        return "winmm error " + code;
    }

    static void WaveCallback(IntPtr hwi, uint uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2)
    {
        if (uMsg != WIM_DATA) return;
        if (stopping || finished) return;
        try
        {
            WAVEHDR hdr = (WAVEHDR)Marshal.PtrToStructure(dwParam1, typeof(WAVEHDR));
            uint recorded = hdr.dwBytesRecorded;
            if (recorded > 0 && recorded <= hdr.dwBufferLength)
            {
                byte[] data = new byte[recorded];
                Marshal.Copy(hdr.lpData, data, 0, (int)recorded);
                string b64 = Convert.ToBase64String(data);
                Emit("audio", "\"data\":\"" + b64 + "\"");
            }
            if (!stopping && !finished)
            {
                // requeue same header (dwBytesRecorded will be reset by driver)
                // Need to reset flags? waveInAddBuffer will reuse.
                int r = waveInAddBuffer(hWaveIn, dwParam1, Marshal.SizeOf(typeof(WAVEHDR)));
                if (r != 0)
                {
                    // If requeue fails, surface error but don't crash callback
                }
            }
        }
        catch (Exception ex)
        {
            // Don't emit from callback if already finishing
            if (!finished) EmitError("wave callback failed: " + ex.Message);
        }
    }

    static void Cleanup()
    {
        if (hWaveIn != IntPtr.Zero)
        {
            try { waveInReset(hWaveIn); } catch { }
            for (int i = 0; i < BUFFER_COUNT; i++)
            {
                if (headerPtrs[i] != IntPtr.Zero)
                {
                    try { waveInUnprepareHeader(hWaveIn, headerPtrs[i], Marshal.SizeOf(typeof(WAVEHDR))); } catch { }
                }
            }
            try { waveInClose(hWaveIn); } catch { }
            hWaveIn = IntPtr.Zero;
        }
        for (int i = 0; i < BUFFER_COUNT; i++)
        {
            if (bufferPtrs[i] != IntPtr.Zero) { Marshal.FreeHGlobal(bufferPtrs[i]); bufferPtrs[i] = IntPtr.Zero; }
            if (headerPtrs[i] != IntPtr.Zero) { Marshal.FreeHGlobal(headerPtrs[i]); headerPtrs[i] = IntPtr.Zero; }
        }
    }

    static void StopAndExit(int code)
    {
        if (finished) return;
        finished = true;
        stopping = true;
        Cleanup();
        if (code == 0) Emit("stopped");
        try { Console.Out.Flush(); } catch { }
        done.Set();
        Environment.Exit(code);
    }

    static int Main(string[] args)
    {
        // Ctrl+C should produce error rather than silent exit
        Console.CancelKeyPress += (s, e) => { e.Cancel = true; StopAndExit(0); };

        if (waveInGetNumDevs() == 0)
        {
            EmitError("No microphone was found. Check Settings \u2192 Privacy & security \u2192 Microphone and ensure access is allowed.");
            return 2;
        }

        var fmt = new WAVEFORMATEX
        {
            wFormatTag = WAVE_FORMAT_PCM,
            nChannels = 1,
            nSamplesPerSec = 16000,
            wBitsPerSample = 16,
            nBlockAlign = 2,
            nAvgBytesPerSec = 32000,
            cbSize = 0
        };

        callbackDelegate = new WaveInProc(WaveCallback);

        int res = waveInOpen(out hWaveIn, WAVE_MAPPER, ref fmt, callbackDelegate, IntPtr.Zero, CALLBACK_FUNCTION);
        if (res != 0)
        {
            string detail = ErrorText(res);
            if (res == 32) detail += " — Microphone is in use by another app.";
            // 5 = MMSYSERR_NODRIVER etc hints
            EmitError("Could not open microphone: " + detail + " Check microphone privacy settings.");
            return 2;
        }

        for (int i = 0; i < BUFFER_COUNT; i++)
        {
            bufferPtrs[i] = Marshal.AllocHGlobal(BUFFER_BYTES);
            headerPtrs[i] = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
            var hdr = new WAVEHDR
            {
                lpData = bufferPtrs[i],
                dwBufferLength = (uint)BUFFER_BYTES,
                dwBytesRecorded = 0,
                dwFlags = 0
            };
            Marshal.StructureToPtr(hdr, headerPtrs[i], false);
            res = waveInPrepareHeader(hWaveIn, headerPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
            if (res != 0) { EmitError("Could not prepare audio buffer: " + ErrorText(res)); Cleanup(); return 3; }
            res = waveInAddBuffer(hWaveIn, headerPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
            if (res != 0) { EmitError("Could not queue audio buffer: " + ErrorText(res)); Cleanup(); return 3; }
        }

        res = waveInStart(hWaveIn);
        if (res != 0) { EmitError("Could not start microphone capture: " + ErrorText(res)); Cleanup(); return 4; }

        Emit("ready", "\"sampleRate\":16000,\"channels\":1,\"encoding\":\"pcm_s16le\"");

        // Wait for "stop" on stdin in background (Console.ReadLine blocks)
        var stdinThread = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    if (line.Trim() == "stop")
                    {
                        stopping = true;
                        try { waveInStop(hWaveIn); } catch { }
                        // Give a brief window for final WIM_DATA to be delivered,
                        // then reset and exit. 150 ms is enough for trailing 100 ms buffer.
                        Thread.Sleep(180);
                        StopAndExit(0);
                        break;
                    }
                }
                // stdin closed (parent died) -> stop as well
                if (!finished)
                {
                    stopping = true;
                    try { waveInStop(hWaveIn); } catch { }
                    Thread.Sleep(120);
                    StopAndExit(0);
                }
            }
            catch { StopAndExit(0); }
        });
        stdinThread.IsBackground = true;
        stdinThread.Start();

        // Block main thread until done signal
        done.WaitOne();
        return 0;
    }
}
