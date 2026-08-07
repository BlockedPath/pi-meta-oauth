#Requires -Version 5.1
# Windows microphone helper for pi-meta-oauth voice (PowerShell fallback).
# Mirrors windows-audio.cs protocol when a compiled exe is not available.
# Uses winmm.dll waveIn* via Add-Type compiled C# — no NAudio / ffmpeg required.
# Protocol:
#   stdout: {"type":"ready",...}
#   stdout: {"type":"audio","data":"<base64>"}
#   stdout: {"type":"stopped"}
#   stdout: {"type":"error","message":"..."}
#   stdin:  "stop\n"
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File windows-audio.ps1

$ErrorActionPreference = "Stop"

$csCode = @"
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public class PsWinVoice
{
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
    const int BUFFER_BYTES = 3200;
    const int BUFFER_COUNT = 3;

    static object emitLock = new object();
    static WaveInProc cb;
    static IntPtr hWaveIn = IntPtr.Zero;
    static IntPtr[] hdrs = new IntPtr[BUFFER_COUNT];
    static IntPtr[] bufs = new IntPtr[BUFFER_COUNT];
    static volatile bool stopping = false;
    static volatile bool finished = false;
    static ManualResetEvent done = new ManualResetEvent(false);

    static void Emit(string t, string extra = null)
    {
        string line = extra == null ? "{\"type\":\"" + t + "\"}" : "{\"type\":\"" + t + "\"," + extra + "}";
        lock (emitLock) { Console.WriteLine(line); Console.Out.Flush(); }
    }
    static void EmitErr(string m)
    {
        string e = m.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        Emit("error", "\"message\":\"" + e + "\"");
    }
    static string ErrTxt(int c)
    {
        var sb = new StringBuilder(256);
        if (waveInGetErrorText(c, sb, sb.Capacity) == 0 && sb.Length > 0) return sb.ToString();
        return "winmm error " + c;
    }
    static void Callback(IntPtr hwi, uint uMsg, IntPtr a, IntPtr pHdr, IntPtr b)
    {
        if (uMsg != 0x3C0) return;
        if (stopping || finished) return;
        try
        {
            WAVEHDR h = (WAVEHDR)Marshal.PtrToStructure(pHdr, typeof(WAVEHDR));
            uint n = h.dwBytesRecorded;
            if (n > 0 && n <= h.dwBufferLength)
            {
                byte[] d = new byte[n];
                Marshal.Copy(h.lpData, d, 0, (int)n);
                Emit("audio", "\"data\":\"" + Convert.ToBase64String(d) + "\"");
            }
            if (!stopping && !finished) waveInAddBuffer(hWaveIn, pHdr, Marshal.SizeOf(typeof(WAVEHDR)));
        }
        catch (Exception ex) { if (!finished) EmitErr("wave callback failed: " + ex.Message); }
    }
    static void Cleanup()
    {
        if (hWaveIn != IntPtr.Zero)
        {
            try { waveInReset(hWaveIn); } catch {}
            for (int i = 0; i < BUFFER_COUNT; i++) if (hdrs[i] != IntPtr.Zero) try { waveInUnprepareHeader(hWaveIn, hdrs[i], Marshal.SizeOf(typeof(WAVEHDR))); } catch {}
            try { waveInClose(hWaveIn); } catch {}
            hWaveIn = IntPtr.Zero;
        }
        for (int i = 0; i < BUFFER_COUNT; i++)
        {
            if (bufs[i] != IntPtr.Zero) { Marshal.FreeHGlobal(bufs[i]); bufs[i]=IntPtr.Zero; }
            if (hdrs[i] != IntPtr.Zero) { Marshal.FreeHGlobal(hdrs[i]); hdrs[i]=IntPtr.Zero; }
        }
    }
    static void StopOk(int code)
    {
        if (finished) return;
        finished = true; stopping = true;
        Cleanup();
        if (code == 0) Emit("stopped");
        try { Console.Out.Flush(); } catch {}
        done.Set();
        Environment.Exit(code);
    }

    public static int Run()
    {
        if (waveInGetNumDevs() == 0) { EmitErr("No microphone was found. Check Settings \u2192 Privacy & security \u2192 Microphone."); return 2; }
        var fmt = new WAVEFORMATEX { wFormatTag = 1, nChannels = 1, nSamplesPerSec = 16000, wBitsPerSample = 16, nBlockAlign = 2, nAvgBytesPerSec = 32000, cbSize = 0 };
        cb = new WaveInProc(Callback);
        int r = waveInOpen(out hWaveIn, WAVE_MAPPER, ref fmt, cb, IntPtr.Zero, CALLBACK_FUNCTION);
        if (r != 0) { EmitErr("Could not open microphone: " + ErrTxt(r) + ". Check microphone privacy settings."); return 2; }
        for (int i=0;i<BUFFER_COUNT;i++)
        {
            bufs[i] = Marshal.AllocHGlobal(BUFFER_BYTES);
            hdrs[i] = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
            var h = new WAVEHDR { lpData = bufs[i], dwBufferLength = (uint)BUFFER_BYTES };
            Marshal.StructureToPtr(h, hdrs[i], false);
            r = waveInPrepareHeader(hWaveIn, hdrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
            if (r!=0){ EmitErr("Could not prepare buffer: "+ErrTxt(r)); Cleanup(); return 3; }
            r = waveInAddBuffer(hWaveIn, hdrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
            if (r!=0){ EmitErr("Could not queue buffer: "+ErrTxt(r)); Cleanup(); return 3; }
        }
        r = waveInStart(hWaveIn);
        if (r!=0){ EmitErr("Could not start capture: "+ErrTxt(r)); Cleanup(); return 4; }
        Emit("ready", "\"sampleRate\":16000,\"channels\":1,\"encoding\":\"pcm_s16le\"");
        var t = new Thread(() => {
            try {
                string l;
                while ((l = Console.ReadLine()) != null) {
                    if (l.Trim() == "stop") { stopping=true; try{ waveInStop(hWaveIn);}catch{} Thread.Sleep(180); StopOk(0); break; }
                }
                if (!finished) { stopping=true; try{ waveInStop(hWaveIn);}catch{} Thread.Sleep(120); StopOk(0); }
            } catch { StopOk(0); }
        });
        t.IsBackground=true; t.Start();
        done.WaitOne();
        return 0;
    }
}
"@

try {
    Add-Type -TypeDefinition $csCode -Language CSharp -ErrorAction Stop | Out-Null
} catch {
    # Emit JSON error expected by TypeScript fail path
    $msg = $_.Exception.Message.Replace('\','\\').Replace('"','\"')
    Write-Output ('{"type":"error","message":"Failed to initialize Windows audio capture: ' + $msg + '"}')
    exit 3
}

# Ensure Console uses UTF8 without BOM for JSON lines
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$code = [PsWinVoice]::Run()
exit $code
