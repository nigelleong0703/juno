import AVFoundation
import Observation

/// Dictation into the composer: record a short clip, send it to the backend (`POST /v1/transcriptions`), and hand back
/// the text for the composer to append after whatever is in the field by then. `toggle` starts and stops; a clip stops
/// by itself after two minutes.
@MainActor @Observable
final class Dictation {
    private(set) var listening = false
    /// The clip is on its way to the backend, waiting for the text.
    private(set) var transcribing = false
    /// Why it could not start or finish (permission refused, no server support), for the composer to show.
    private(set) var problem: String?

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var file: URL?
    @ObservationIgnored private var limit: Task<Void, Never>?
    @ObservationIgnored private var job: Task<Void, Never>?

    private static let maxSeconds: Double = 120

    /// The field's text with the spoken words after it, a space between.
    static func append(_ spoken: String, to text: String) -> String {
        let lead = text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? text : text + " "
        return lead + spoken
    }

    func toggle(transcribe: @escaping (Data) async throws -> String, insert: @escaping (String) -> Void) {
        if listening { finish(transcribe: transcribe, insert: insert) }
        else if !transcribing { Task { await start(transcribe: transcribe, insert: insert) } }
    }

    /// Drops whatever is recording or in flight without inserting anything (the composer went away).
    func stop() {
        limit?.cancel(); job?.cancel()
        recorder?.stop()
        recorder = nil
        discardFile()
        guard listening || transcribing else { return }
        listening = false; transcribing = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func start(transcribe: @escaping (Data) async throws -> String, insert: @escaping (String) -> Void) async {
        problem = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            problem = "Turn on Microphone for Juno in Settings to dictate."
            return
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-\(UUID().uuidString).m4a")
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            guard recorder.record() else { throw CocoaError(.fileWriteUnknown) }
            self.recorder = recorder
            file = url
        } catch {
            try? FileManager.default.removeItem(at: url)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            problem = "Couldn't start the microphone."
            return
        }
        listening = true
        limit = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.maxSeconds))
            guard !Task.isCancelled else { return }
            self?.finish(transcribe: transcribe, insert: insert)
        }
    }

    private func finish(transcribe: @escaping (Data) async throws -> String, insert: @escaping (String) -> Void) {
        guard listening else { return }
        limit?.cancel()
        recorder?.stop()
        recorder = nil
        listening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let url = file, let audio = try? Data(contentsOf: url), !audio.isEmpty else {
            discardFile()
            return
        }
        transcribing = true
        job = Task { [weak self] in
            let result: Result<String, Error>
            do { result = .success(try await transcribe(audio)) } catch { result = .failure(error) }
            guard let self, !Task.isCancelled else { return }
            self.discardFile()
            self.transcribing = false
            switch result {
            case .success(let spoken):
                let spoken = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
                if !spoken.isEmpty { insert(spoken) }
            case .failure(let error):
                if case APIError.api(let status, _, _) = error, status == 503 { self.problem = "Dictation isn't set up on this server." }
                else if case APIError.http(503, _) = error { self.problem = "Dictation isn't set up on this server." }
                else { self.problem = "Couldn't transcribe that. Try again." }
            }
        }
    }

    private func discardFile() {
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
    }
}
