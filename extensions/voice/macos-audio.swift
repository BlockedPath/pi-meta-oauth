import AVFoundation
import Foundation

private let outputQueue = DispatchQueue(label: "com.pi.muse.meta-voice.output")

private func emitNow(_ type: String, _ fields: [String: Any] = [:]) {
    var payload = fields
    payload["type"] = type
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else {
        return
    }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

private func emit(_ type: String, _ fields: [String: Any] = [:]) {
    outputQueue.async {
        emitNow(type, fields)
    }
}

private final class MicrophoneSession {
    private let audioEngine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var stopping = false
    private var finished = false

    func start() {
        requestMicrophoneAccess()
    }

    private func requestMicrophoneAccess() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            beginCapture()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted {
                        self.beginCapture()
                    } else {
                        self.fail("Microphone permission was not granted. Enable it in System Settings → Privacy & Security → Microphone.", exitCode: 2)
                    }
                }
            }
        default:
            fail("Microphone permission is disabled. Enable it in System Settings → Privacy & Security → Microphone.", exitCode: 2)
        }
    }

    private func beginCapture() {
        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            fail("The selected microphone returned an invalid audio format.", exitCode: 3)
            return
        }
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ), let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            fail("Could not initialize 16 kHz microphone conversion.", exitCode: 3)
            return
        }
        self.converter = converter

        let tap: AVAudioNodeTapBlock = { [weak self] buffer, _ in
            self?.convertAndEmit(buffer, outputFormat: outputFormat)
        }
        let tapBufferSize = AVAudioFrameCount(inputFormat.sampleRate * 0.1)
        do {
            inputNode.installTap(
                onBus: 0,
                bufferSize: tapBufferSize,
                format: inputFormat,
                block: tap
            )
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            fail("Could not start microphone capture: \(error.localizedDescription)", exitCode: 4)
            return
        }

        emit("ready", [
            "sampleRate": 16_000,
            "channels": 1,
            "encoding": "pcm_s16le"
        ])

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            _ = readLine()
            DispatchQueue.main.async {
                self?.stop()
            }
        }
    }

    private func convertAndEmit(_ input: AVAudioPCMBuffer, outputFormat: AVAudioFormat) {
        guard !stopping, !finished, let converter else { return }
        let ratio = outputFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return
        }

        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if suppliedInput {
                inputStatus.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            inputStatus.pointee = .haveData
            return input
        }

        if let conversionError {
            emit("error", ["message": "Microphone conversion failed: \(conversionError.localizedDescription)"])
            return
        }
        guard status != .error,
              output.frameLength > 0,
              let samples = output.int16ChannelData?[0] else {
            return
        }

        let byteCount = Int(output.frameLength) * MemoryLayout<Int16>.size
        let audio = Data(bytes: samples, count: byteCount)
        emit("audio", ["data": audio.base64EncodedString()])
    }

    func stop() {
        guard !stopping, !finished else { return }
        stopping = true
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        converter = nil
        finished = true
        outputQueue.async {
            emitNow("stopped")
            fflush(stdout)
            exit(0)
        }
    }

    private func fail(_ message: String, exitCode: Int32) {
        guard !finished else { return }
        finished = true
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        outputQueue.async {
            emitNow("error", ["message": message])
            fflush(stdout)
            exit(exitCode)
        }
    }
}

private let session = MicrophoneSession()
session.start()
RunLoop.main.run()
