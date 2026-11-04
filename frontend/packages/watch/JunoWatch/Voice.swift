@preconcurrency import AVFoundation
import CoreML
import OSLog

let voiceLog = Logger(subsystem: "io.github.nigelleong0703.juno.watch", category: "voice")

/// Silero VAD v6.2.1 (speech or not, per 32 ms frame) and Smart Turn v3.2 (has the speaker finished?), both CoreML,
/// bundled from `Models/` (scripts/fetch-models.sh). Silero keeps its LSTM state between frames, so one listener uses
/// an instance at a time.
final class VoiceModels: @unchecked Sendable {
    /// Started when the app launches; the first load after an install takes tens of seconds, a warm one ~0.1 s.
    static let loading = Task.detached(priority: .utility) { () throws -> VoiceModels in
        let start = DispatchTime.now()
        let models = try VoiceModels()
        voiceLog.notice("models loaded in \(Int((DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000), privacy: .public) ms")
        return models
    }

    private let silero: MLModel
    private let smart: MLModel
    private var h: MLMultiArray
    private var c: MLMultiArray
    private var context = [Float](repeating: 0, count: 64)

    private static func bundled(_ name: String) throws -> URL {
        guard let url = Bundle.main.url(forResource: name, withExtension: "mlmodelc", subdirectory: "Models") else {
            throw NSError(domain: "juno-watch", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(name) is missing from the bundle"])
        }
        return url
    }

    private init() throws {
        let config = MLModelConfiguration()
        silero = try MLModel(contentsOf: Self.bundled("silero_vad"), configuration: config)
        smart = try MLModel(contentsOf: Self.bundled("smart_turn"), configuration: config)
        h = try MLMultiArray(shape: [1, 1, 128], dataType: .float32)
        c = try MLMultiArray(shape: [1, 1, 128], dataType: .float32)
        resetSilero()
    }

    func resetSilero() {
        for i in 0..<128 { h[i] = 0; c[i] = 0 }
        context = [Float](repeating: 0, count: 64)
    }

    /// One 512-sample (32 ms) frame of 16 kHz audio -> speech probability.
    func vad(_ frame: [Float]) throws -> Float {
        let input = try MLMultiArray(shape: [1, 1, 576], dataType: .float32)
        let p = input.dataPointer.bindMemory(to: Float.self, capacity: 576)
        for i in 0..<64 { p[i] = context[i] }
        for i in 0..<512 { p[64 + i] = frame[i] }
        context = Array(frame[448..<512])
        let out = try silero.prediction(from: MLDictionaryFeatureProvider(dictionary: ["audio": input, "h": h, "c": c]))
        h = out.featureValue(for: "h_out")!.multiArrayValue!
        c = out.featureValue(for: "c_out")!.multiArrayValue!
        return out.featureValue(for: "probability")!.multiArrayValue![0].floatValue
    }

    /// The utterance so far (the last 8 s, zeros in front) -> probability that the turn is complete. Only meaningful after a trailing pause.
    func turn(_ samples: [Float]) throws -> Float {
        let n = 128_000
        let input = try MLMultiArray(shape: [1, NSNumber(value: n)], dataType: .float32)
        let p = input.dataPointer.bindMemory(to: Float.self, capacity: n)
        let tail = samples.suffix(n)
        let offset = n - tail.count
        for i in 0..<offset { p[i] = 0 }
        for (i, s) in tail.enumerated() { p[offset + i] = s }
        let out = try smart.prediction(from: MLDictionaryFeatureProvider(dictionary: ["audio": input]))
        return out.featureValue(for: "probability")!.multiArrayValue![0].floatValue
    }
}

/// Mic -> Silero per frame -> Smart Turn on a pause. Ends by itself when the turn is over; the microphone is released then.
///
/// - After 7 silent frames (224 ms) that follow speech, Smart Turn judges the last 8 s: p >= 0.5 ends the turn, otherwise it
///   keeps listening and asks again at the next pause. A call slower than 400 ms counts as "not done yet".
/// - 3 s of continuous silence ends the turn anyway; no speech in 8 s gives up quietly; 30 s is the hard cap.
final class VoiceListener: @unchecked Sendable {
    enum End {
        /// The speech captured (16 kHz mono).
        case speech([Float])
        /// Nothing worth sending: no speech, or cancelled.
        case nothing
    }

    private static let frame = 512
    private static let pauseFrames = 7          // 224 ms
    private static let silenceStopFrames = 94   // 3 s
    private static let noSpeechFrames = 250     // 8 s
    private static let capFrames = 937          // 30 s
    private static let turnBudgetMs = 400.0

    private let models: VoiceModels
    private let onEnd: @Sendable (End) -> Void
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "io.github.nigelleong0703.juno.watch.listen")
    private var converter: AVAudioConverter?
    private var pending: [Float] = []
    private var all: [Float] = []
    private var frames = 0
    private var inSpeech = false
    private var silence = 0
    private var asked = false
    private var done = false

    init(models: VoiceModels, onEnd: @escaping @Sendable (End) -> Void) {
        self.models = models
        self.onEnd = onEnd
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        models.resetSilero()
        let hardware = engine.inputNode.outputFormat(forBus: 0)
        let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        converter = AVAudioConverter(from: hardware, to: target)
        engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: hardware) { [weak self] buffer, _ in
            guard let self else { return }
            queue.async { self.consume(buffer, target) }
        }
        do { try engine.start() } catch { release(); throw error }
        voiceLog.notice("listening (mic \(Int(hardware.sampleRate), privacy: .public) Hz)")
    }

    /// The user tapped again (`send`) or the page changed (not `send`).
    func stop(send: Bool) {
        queue.async { self.finish(send ? "tapped" : "cancelled", send: send) }
    }

    private func release() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func consume(_ buffer: AVAudioPCMBuffer, _ target: AVAudioFormat) {
        guard !done, let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if let error { voiceLog.error("convert failed: \(error.localizedDescription, privacy: .public)"); return }
        pending += UnsafeBufferPointer(start: out.floatChannelData![0], count: Int(out.frameLength))
        while pending.count >= Self.frame, !done {
            let frame = Array(pending[0..<Self.frame])
            pending.removeFirst(Self.frame)
            all += frame
            process(frame)
        }
    }

    private func process(_ frame: [Float]) {
        frames += 1
        guard let p = try? models.vad(frame) else { return }
        if p >= 0.5 {
            inSpeech = true
            silence = 0
            asked = false
        } else if inSpeech && p < 0.35 {
            silence += 1
            if silence == Self.pauseFrames && !asked {
                asked = true
                let start = DispatchTime.now()
                let prob = try? models.turn(all)
                let ms = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e6
                if ms > Self.turnBudgetMs {
                    voiceLog.notice("turn check took \(Int(ms), privacy: .public) ms, too slow: keep listening")
                } else if let prob {
                    voiceLog.notice("turn p=\(prob, format: .fixed(precision: 2), privacy: .public) in \(Int(ms), privacy: .public) ms")
                    if prob >= 0.5 { finish("turn complete", send: true); return }
                }
            } else if silence >= Self.silenceStopFrames {
                finish("3 s of silence", send: true)
                return
            }
        }
        if !inSpeech && frames >= Self.noSpeechFrames { finish("no speech in 8 s", send: false) }
        else if frames >= Self.capFrames { finish("30 s cap", send: inSpeech) }
    }

    private func finish(_ reason: String, send: Bool) {
        guard !done else { return }
        done = true
        let end: End = send && inSpeech ? .speech(all) : .nothing
        voiceLog.notice("listening ended (\(reason, privacy: .public)), \(self.frames * Self.frame / 16, privacy: .public) ms captured, \(send && self.inSpeech ? "sent" : "dropped", privacy: .public)")
        DispatchQueue.main.async {
            self.release()
            self.onEnd(end)
        }
    }
}

/// 16 kHz mono samples -> AAC m4a, what `POST /v1/transcriptions` takes.
func encodeM4A(_ samples: [Float]) throws -> Data {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
    defer { try? FileManager.default.removeItem(at: url) }
    do {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        let file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        try file.write(from: buffer)
    }  // the file is closed (and finalized) here
    return try Data(contentsOf: url)
}
