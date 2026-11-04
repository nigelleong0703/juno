import AVFoundation
import SwiftUI
import WatchKit

/// What the character is doing; each mood plays one clip of its animation set.
enum Mood {
    case idle, listening, thinking, speaking, failed

    var clip: String {
        switch self {
        case .idle, .listening: "idle"
        case .thinking: "thinking"
        case .speaking: "happy"
        case .failed: "failed"
        }
    }
}

/// One swipeable page: an agent, its character and its direct chat (created on the first message if it has none).
struct AgentPage: Identifiable {
    var id: String
    var name: String
    var character: String
    var conversationId: String?
}

/// The whole interaction: swipe to the agent, tap the character and talk (Silero + Smart Turn decide when you are done);
/// the speech is transcribed on the server, sent to that agent's chat, and its reply is spoken. A message the agent writes
/// on its own is spoken too.
@MainActor @Observable
final class CompanionModel {
    private(set) var mood: Mood = .idle
    private(set) var pages: [AgentPage] = []
    private(set) var loaded = false
    /// The first tap came before the voice models finished loading.
    private(set) var preparing = false
    private(set) var selected = UserDefaults.standard.string(forKey: "lastAgent") ?? ""
    private let client: WatchClient
    private let onSignedOut: () -> Void
    private var spoken = Set<String>()
    private var primed = Set<String>()
    private var thinkingSince = Date.distantPast
    private let speaker: ReplySpeaker
    private var listener: VoiceListener?

    init(session: WatchSession, onSignedOut: @escaping () -> Void) {
        client = WatchClient(server: session.server, token: session.token)
        speaker = ReplySpeaker(client: client)
        self.onSignedOut = onSignedOut
        speaker.onFinished = { [weak self] in self?.speakNext() }
    }

    /// Bubbles that arrived and are waiting to be read out, oldest first (a reply comes as several bubbles).
    private var queue: [String] = []

    /// Read the next waiting bubble, or go idle when there is none.
    private func speakNext() {
        guard mood == .speaking else { return }
        if queue.isEmpty { mood = .idle } else { speaker.speak(queue.removeFirst()) }
    }

    private func stopSpeaking() {
        queue.removeAll()
        speaker.stop()
    }

    var current: AgentPage? { pages.first { $0.id == selected } }

    func select(_ id: String) {
        guard id != selected else { return }
        stopSpeaking()
        listener?.stop(send: false)
        preparing = false
        if mood != .thinking { mood = .idle }
        selected = id
        UserDefaults.standard.set(id, forKey: "lastAgent")
    }

    /// Follow the selected agent's chat while the view is on screen: new agent messages are spoken, faster while a reply is awaited.
    func run() async {
        while !Task.isCancelled {
            if pages.isEmpty { await loadPages() }
            await refresh()
            try? await Task.sleep(for: .seconds(mood == .thinking || mood == .speaking ? 1.2 : 3))
        }
    }

    // MARK: Talking

    /// Tap on the character: stops speech, ends listening early, or starts listening.
    func talk() {
        switch mood {
        case .speaking:
            stopSpeaking()
            mood = .idle
        case .listening: listener?.stop(send: true)
        case .thinking: break
        default:
            if preparing { preparing = false } else { Task { await startListening() } }
        }
    }

    private func startListening() async {
        preparing = true
        let models: VoiceModels
        do { models = try await VoiceModels.loading.value } catch {
            preparing = false
            voiceLog.error("voice models failed to load: \(error.localizedDescription, privacy: .public)")
            fail(nil)
            return
        }
        // Tapping again while it was getting ready cancels.
        guard preparing else { return }
        preparing = false
        guard await AVAudioApplication.requestRecordPermission() else { fail(nil); return }
        let listener = VoiceListener(models: models) { [weak self] end in
            Task { @MainActor in self?.listened(end) }
        }
        do { try listener.start() } catch {
            voiceLog.error("listening failed to start: \(error.localizedDescription, privacy: .public)")
            fail(error)
            return
        }
        self.listener = listener
        mood = .listening
    }

    private func listened(_ end: VoiceListener.End) {
        listener = nil
        guard mood == .listening else { return }
        guard case .speech(let samples) = end else { mood = .idle; return }
        WKInterfaceDevice.current().play(.click)
        mood = .thinking
        thinkingSince = Date()
        let page = current
        Task {
            do {
                let text = try await client.transcribe(try encodeM4A(samples)).trimmingCharacters(in: .whitespacesAndNewlines)
                voiceLog.notice("transcribed \(text.count, privacy: .public) characters")
                guard !text.isEmpty, let page else { mood = .idle; return }
                try await send(text, to: page)
            } catch { fail(error) }
        }
    }

    /// Send the text to the agent's direct chat (created if it has none); the reply comes through `refresh`.
    private func send(_ text: String, to page: AgentPage) async throws {
        let conversationId: String
        if let existing = page.conversationId { conversationId = existing } else {
            conversationId = try await client.createDirect(with: page.id)
            if let i = pages.firstIndex(where: { $0.id == page.id }) { pages[i].conversationId = conversationId }
        }
        try await client.send(text, to: conversationId)
    }

    // MARK: Listening to the chat

    private func loadPages() async {
        do {
            let agents = try await client.agents()
            let direct = try await client.conversations().filter { $0.kind == "direct" }
            pages = agents.map { agent in
                let chat = direct.filter { $0.agentIds?.contains(agent.id) == true }
                    .max { ($0.lastMessage?.at ?? .distantPast) < ($1.lastMessage?.at ?? .distantPast) }
                return AgentPage(id: agent.id, name: agent.name ?? "", character: agent.avatar?.character ?? CharacterSprite.defaultCharacter(agent.id),
                                 conversationId: chat?.id)
            }
            loaded = true
            if current == nil, let first = pages.first { select(first.id) }
        } catch { pollFailed(error) }
    }

    private func refresh() async {
        guard let conversationId = current?.conversationId else { return }
        do {
            let fresh = try await client.items(conversationId).filter { $0.type == "agent_message" && !spoken.contains($0.id) }.reversed()
            spoken.formUnion(fresh.map(\.id))
            // The first look at a chat only learns what was already said; it is not read out.
            guard primed.contains(conversationId) else { primed.insert(conversationId); return }
            // The page may have changed while the request was out.
            guard conversationId == current?.conversationId else { return }
            queue += fresh.map(\.body).filter { !$0.isEmpty }
            if !queue.isEmpty, mood == .idle || mood == .thinking {
                if mood == .idle { WKInterfaceDevice.current().play(.notification) }
                mood = .speaking
                speakNext()
            } else if mood == .thinking, Date().timeIntervalSince(thinkingSince) > 90 {
                mood = .idle
            }
        } catch { pollFailed(error) }
    }

    /// The background polling retries every few seconds, so a failure there is logged only: no haptic, no failed glow.
    private func pollFailed(_ error: Error) {
        if let api = error as? WatchAPIError, api.status == 401 { onSignedOut(); return }
        voiceLog.notice("polling failed: \(error.localizedDescription, privacy: .public)")
    }

    private func fail(_ error: Error?) {
        if let api = error as? WatchAPIError, api.status == 401 { onSignedOut(); return }
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
        Group {
            if model.pages.isEmpty {
                // No agent yet (or still loading): the default character sleeps.
                page(AgentPage(id: "", name: model.loaded ? "No agents" : "", character: "bean"), asleep: true)
            } else {
                TabView(selection: Binding(get: { model.selected }, set: { model.select($0) })) {
                    ForEach(model.pages) { agent in
                        page(agent, asleep: false).tag(agent.id)
                    }
                }
                .tabViewStyle(.page)
            }
        }
        .task { await model.run() }
        .confirmationDialog("Sign out of this watch?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { onSignedOut() }
        }
    }

    private func page(_ agent: AgentPage, asleep: Bool) -> some View {
        let active = agent.id == model.selected && !asleep
        let mood = active ? model.mood : .idle
        let preparing = active && model.preparing
        return VStack(spacing: 2) {
            ZStack {
                Circle().fill(glow(mood).opacity(0.28)).blur(radius: 28).frame(width: 114, height: 114)
                SpriteView(character: agent.character, clip: asleep ? "sleeping" : mood.clip, size: 112)
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            // The character is the talk button, like Siri: tap to talk, tap again to finish early or to stop it speaking.
            .onTapGesture { if !asleep { model.talk() } }
            // Hidden on purpose: pressing and holding the character is how you sign this watch out.
            .onLongPressGesture(minimumDuration: 1.2) { confirmSignOut = true }
            Text(preparing ? "Getting ready…" : agent.name).font(.footnote.weight(.medium)).lineLimit(1)
            Image(systemName: mood == .speaking || mood == .listening ? "stop.fill" : "mic.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tint(agent.character))
                .frame(width: 24, height: 24)
                .background(tint(agent.character).opacity(0.18), in: .circle)
                .opacity(asleep || mood == .thinking ? 0.3 : 1)
        }
    }

    private func tint(_ character: String) -> Color {
        switch character {
        case "mint": .mint
        case "blue": .blue
        case "purple": .purple
        case "pink": .pink
        case "star": .yellow
        default: .orange
        }
    }

    private func glow(_ mood: Mood) -> Color {
        switch mood {
        case .idle: .white
        case .listening: .green
        case .thinking: .purple
        case .speaking: .yellow
        case .failed: .red
        }
    }
}
