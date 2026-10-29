import AVFoundation
import NaturalLanguage
import SwiftUI
import WatchKit

/// What the character is doing; each mood plays one clip of its animation set.
enum Mood {
    case idle, listening, thinking, speaking, failed

    var clip: String {
        switch self {
        case .idle: "idle"
        case .listening: "needs_you"
        case .thinking: "thinking"
        case .speaking: "happy"
        case .failed: "failed"
        }
    }
}

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

/// The whole interaction: tap the mic, talk, tap again; the recording is transcribed by the backend and sent to the
/// chat, the agent's reply is spoken. A message the agent writes on its own is spoken too.
@MainActor @Observable
final class CompanionModel {
    private(set) var mood: Mood = .idle
    private(set) var character = "bean"
    /// No chat to follow yet: the character sleeps.
    private(set) var asleep = false
    private let client: WatchClient
    private let onSignedOut: () -> Void
    private var conversationId: String?
    private var spoken = Set<String>()
    private var primed = false
    private var thinkingSince = Date.distantPast
    private let synthesizer = AVSpeechSynthesizer()
    private let speech = SpeechDelegate()
    private var recorder: AVAudioRecorder?
    private var autoStop: Task<Void, Never>?

    init(session: WatchSession, onSignedOut: @escaping () -> Void) {
        client = WatchClient(server: session.server, token: session.token)
        self.onSignedOut = onSignedOut
        synthesizer.delegate = speech
        speech.onFinished = { [weak self] in if self?.mood == .speaking { self?.mood = .idle } }
    }

    var clip: String { asleep ? "sleeping" : mood.clip }

    /// Follow the chat while the view is on screen: new agent messages are spoken, faster while a reply is awaited.
    func run() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(mood == .thinking ? 1.2 : 3))
        }
    }

    func micTapped() {
        switch mood {
        case .listening: Task { await finishRecording() }
        case .thinking: break
        default: Task { await startRecording() }
        }
    }

    // MARK: Talking

    private func startRecording() async {
        synthesizer.stopSpeaking(at: .immediate)
        guard await AVAudioApplication.requestRecordPermission() else { fail(nil); return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default)
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("say.m4a")
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000,
            ])
            guard recorder.record() else { fail(nil); return }
            self.recorder = recorder
            mood = .listening
            WKInterfaceDevice.current().play(.start)
            autoStop = Task { try? await Task.sleep(for: .seconds(30)); if !Task.isCancelled { await finishRecording() } }
        } catch { fail(error) }
    }

    private func finishRecording() async {
        autoStop?.cancel()
        guard let recorder, mood == .listening else { return }
        let seconds = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        WKInterfaceDevice.current().play(.stop)
        guard seconds > 0.4, let data = try? Data(contentsOf: recorder.url) else { mood = .idle; return }
        mood = .thinking
        thinkingSince = Date()
        do {
            let text = try await client.transcribe(data).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { mood = .idle; return }
            if conversationId == nil { await refresh() }
            guard let conversationId else { mood = .idle; return }
            try await client.send(text, to: conversationId)
        } catch { fail(error) }
    }

    // MARK: Listening to the chat

    private func refresh() async {
        do {
            if conversationId == nil { try await pickConversation() }
            guard let conversationId else { asleep = true; return }
            asleep = false
            let fresh = try await client.items(conversationId).filter { $0.type == "agent_message" && !spoken.contains($0.id) }.reversed()
            spoken.formUnion(fresh.map(\.id))
            // The first look only learns what was already said; it is not read out.
            guard primed else { primed = true; return }
            let lines = fresh.map(\.body).filter { !$0.isEmpty }
            if !lines.isEmpty, mood == .idle || mood == .thinking {
                if mood == .idle { WKInterfaceDevice.current().play(.notification) }
                speak(lines)
            } else if mood == .thinking, Date().timeIntervalSince(thinkingSince) > 90 {
                mood = .idle
            }
        } catch { fail(error) }
    }

    /// The direct chat that was active most recently, and the character of its agent.
    private func pickConversation() async throws {
        let direct = try await client.conversations().filter { $0.kind == "direct" }
        guard let chat = direct.max(by: { ($0.lastMessage?.at ?? .distantPast) < ($1.lastMessage?.at ?? .distantPast) }) else { return }
        conversationId = chat.id
        if let agentId = chat.agentIds?.first {
            let agent = try? await client.agent(agentId)
            character = agent?.avatar?.character ?? CharacterSprite.defaultCharacter(agentId)
        }
    }

    // MARK: Speaking

    private func speak(_ lines: [String]) {
        mood = .speaking
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        for line in lines {
            let utterance = AVSpeechUtterance(string: Self.spoken(line))
            if let tag = NLLanguageRecognizer.dominantLanguage(for: line)?.rawValue {
                utterance.voice = AVSpeechSynthesisVoice(language: tag == "zh-Hans" ? "zh-CN" : tag)
            }
            speech.pending += 1
            synthesizer.speak(utterance)
        }
    }

    /// Markdown marks and links read badly aloud.
    private static func spoken(_ text: String) -> String {
        text.replacingOccurrences(of: #"https?://\S+"#, with: "", options: .regularExpression)
            .filter { !"*_#`>".contains($0) }
    }

    private func fail(_ error: Error?) {
        if let api = error as? WatchAPIError, api.status == 401 { onSignedOut(); return }
        recorder?.stop()
        recorder = nil
        mood = .failed
        WKInterfaceDevice.current().play(.failure)
        Task { try? await Task.sleep(for: .seconds(2.5)); if mood == .failed { mood = .idle } }
    }
}

struct CompanionView: View {
    @State private var model: CompanionModel
    @State private var confirmSignOut = false
    private let onSignedOut: () -> Void

    init(session: WatchSession, onSignedOut: @escaping () -> Void) {
        _model = State(initialValue: CompanionModel(session: session, onSignedOut: onSignedOut))
        self.onSignedOut = onSignedOut
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Circle().fill(glow.opacity(0.28)).blur(radius: 28).frame(width: 114, height: 114)
                SpriteView(character: model.character, clip: model.clip, size: 112)
            }
            .frame(maxHeight: .infinity)
            // Hidden on purpose: pressing and holding the character is how you sign this watch out.
            .onLongPressGesture(minimumDuration: 1.2) { confirmSignOut = true }
            Button(action: model.micTapped) {
                Image(systemName: model.mood == .listening ? "stop.fill" : "mic.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(model.mood == .listening ? Color.red : Color.white.opacity(0.18), in: .circle)
            }
            .buttonStyle(.plain)
            .disabled(model.mood == .thinking)
            .opacity(model.mood == .thinking ? 0.4 : 1)
        }
        .task { await model.run() }
        .confirmationDialog("Sign out of this watch?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { onSignedOut() }
        }
    }

    private var glow: Color {
        switch model.mood {
        case .idle: .white
        case .listening: .blue
        case .thinking: .purple
        case .speaking: .yellow
        case .failed: .red
        }
    }
}
