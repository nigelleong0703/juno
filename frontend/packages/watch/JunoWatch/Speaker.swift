@preconcurrency import AVFoundation
import NaturalLanguage

/// Counts the queued utterances and calls back when the speech queue runs dry.
@MainActor private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var pending = 0
    var onFinished: () -> Void = {}

    private func utteranceEnded() {
        pending = max(0, pending - 1)
        if pending == 0 { onFinished() }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in utteranceEnded() }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in utteranceEnded() }
    }
}

/// Tells the awaiting task that one audio file has played to its end.
private final class FileDelegate: NSObject, AVAudioPlayerDelegate, @unchecked Sendable {
    var done: (() -> Void)?

    func finish() {
        let callback = done
        done = nil
        callback?()
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { DispatchQueue.main.async { self.finish() } }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { DispatchQueue.main.async { self.finish() } }
}

/// Reads a reply aloud. The server's Kokoro voice first (`POST /v1/speech` returns sentence-sized parts): every part is
/// downloaded with the authenticated client into a temp file, all downloads start at once, and the files are played in
/// order as they land (the next one is usually ready when one ends). A part that fails (502 / 504) is skipped. When the
/// server cannot (503, offline, any error on the POST) the on-device AVSpeechSynthesizer speaks it instead.
@MainActor final class ReplySpeaker {
    var onFinished: () -> Void = {}
    private let client: WatchClient
    private let synthesizer = AVSpeechSynthesizer()
    private let delegate = SpeechDelegate()
    private let fileDelegate = FileDelegate()
    private var task: Task<Void, Never>?
    private var audio: AVAudioPlayer?

    init(client: WatchClient) {
        self.client = client
        synthesizer.delegate = delegate
        delegate.onFinished = { [weak self] in self?.finish() }
    }

    private var started = DispatchTime.now()
    private func elapsedMs() -> Int { Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000) }

    private func finish() {
        voiceLog.notice("reply finished speaking after \(self.elapsedMs(), privacy: .public) ms")
        onFinished()
    }

    func speak(_ text: String) {
        stop()
        let plain = String(Self.spoken(text).prefix(2000))
        guard !plain.isEmpty else { onFinished(); return }
        started = DispatchTime.now()
        voiceLog.notice("reply starts speaking (\(plain.count, privacy: .public) characters)")
        task = Task {
            let parts: [SpeechPart]
            do {
                parts = try await client.speech(plain)
                guard !parts.isEmpty else { throw WatchAPIError(status: 0, code: "", message: "no parts") }
            } catch {
                guard !Task.isCancelled else { return }
                voiceLog.notice("server speech unavailable (\(error.localizedDescription, privacy: .public)), speaking on the device")
                speakOnDevice(plain)
                return
            }
            await play(parts)
            if !Task.isCancelled { finish() }
        }
    }

    /// Stops whatever is playing or queued; `onFinished` is not called.
    func stop() {
        task?.cancel()
        task = nil
        audio?.stop()
        fileDelegate.finish()
        synthesizer.stopSpeaking(at: .immediate)
        delegate.pending = 0
    }

    // MARK: Server voice

    private func play(_ parts: [SpeechPart]) async {
        let client = client
        let downloads = parts.map { part in
            Task.detached { () -> URL? in
                do {
                    let data = try await client.request(part.url)
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
                    try data.write(to: url)
                    return url
                } catch {
                    voiceLog.notice("speech part failed (\(error.localizedDescription, privacy: .public)), skipping it")
                    return nil
                }
            }
        }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        var first = true
        for download in downloads {
            if Task.isCancelled { downloads.forEach { $0.cancel() } }
            guard let url = await download.value else { continue }
            if first, !Task.isCancelled {
                first = false
                voiceLog.notice("speaking with Kokoro: \(parts.count, privacy: .public) parts, first audio after \(self.elapsedMs(), privacy: .public) ms")
            }
            if !Task.isCancelled { await playFile(url) }
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func playFile(_ url: URL) async {
        guard let player = try? AVAudioPlayer(contentsOf: url) else { voiceLog.notice("speech part is not playable, skipping it"); return }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                fileDelegate.done = { continuation.resume() }
                player.delegate = fileDelegate
                audio = player
                if !player.play() { fileDelegate.finish() }
            }
        } onCancel: {
            Task { @MainActor in self.audio?.stop(); self.fileDelegate.finish() }
        }
        audio = nil
    }

    // MARK: On-device voice

    private func speakOnDevice(_ text: String) {
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        let voice = Self.bestVoice(for: text)
        // One utterance per sentence, so the first one starts while the rest is still queued.
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = text
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            let sentence = text[range].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !sentence.isEmpty else { return true }
            let utterance = AVSpeechUtterance(string: sentence)
            utterance.voice = voice
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            delegate.pending += 1
            synthesizer.speak(utterance)
            return true
        }
        if delegate.pending == 0 { finish() }
    }

    /// The best installed voice for the text's language: premium, then enhanced, else the default one.
    private static func bestVoice(for text: String) -> AVSpeechSynthesisVoice? {
        guard let language = NLLanguageRecognizer.dominantLanguage(for: text)?.rawValue else { return nil }
        // NL says zh-Hans / zh-Hant; voices say zh-CN / zh-TW / zh-HK.
        let preferred = language == "zh-Hans" ? "zh-CN" : language == "zh-Hant" ? "zh-TW" : language
        let base = String(language.prefix { $0 != "-" })
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(base) }
        let best = voices.max { score($0, preferred) < score($1, preferred) } ?? AVSpeechSynthesisVoice(language: preferred)
        voiceLog.notice("on-device voice \(language, privacy: .public) -> \(best?.name ?? "default", privacy: .public) quality=\(best?.quality.rawValue ?? 0, privacy: .public)")
        return best
    }

    /// Quality first (premium 3, enhanced 2, default 1), then the exact region.
    private static func score(_ voice: AVSpeechSynthesisVoice, _ language: String) -> Int {
        voice.quality.rawValue * 2 + (voice.language == language ? 1 : 0)
    }

    /// Markdown marks, links and emoji read badly aloud.
    private static func spoken(_ text: String) -> String {
        let plain = text.replacingOccurrences(of: #"https?://\S+"#, with: "", options: .regularExpression)
            .filter { !"*_#`>~|".contains($0) }
        return String(String.UnicodeScalarView(plain.unicodeScalars.filter { !($0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x238C)) }))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
