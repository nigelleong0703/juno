import Foundation

/// Tells the server the user is typing in one direct chat, so the agent waits for the end of a burst before it
/// answers (the web's `useTypingActivity`). Only an activity boolean is ever sent, never the draft. `true` goes out
/// at most once per second, with a trailing one after a burst; `false` goes out when typing stops. Clock, scheduler and
/// poster are injected so the throttling is testable without a network.
@MainActor
final class TypingReporter {
    static let throttle: TimeInterval = 1

    private let now: () -> Date
    private let schedule: (TimeInterval, @escaping @MainActor () -> Void) -> () -> Void
    private let post: (String, Bool) -> Void
    private var conversationId: String?
    private var active = false
    private var lastPost = Date.distantPast
    private var cancelTrailing: (() -> Void)?

    init(now: @escaping () -> Date = Date.init,
         schedule: @escaping (TimeInterval, @escaping @MainActor () -> Void) -> () -> Void = TypingReporter.sleepingSchedule,
         post: @escaping (String, Bool) -> Void) {
        self.now = now
        self.schedule = schedule
        self.post = post
    }

    nonisolated static func sleepingSchedule(_ delay: TimeInterval, _ work: @escaping @MainActor () -> Void) -> () -> Void {
        let task = Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            if !Task.isCancelled { work() }
        }
        return { task.cancel() }
    }

    /// The chat being typed in; nil (a room, no chat) never reports. Switching ends activity on the previous chat.
    func setConversation(_ id: String?) {
        guard id != conversationId else { return }
        stop()
        conversationId = id
    }

    /// The draft changed while the user is typing.
    func report() {
        guard let id = conversationId else { return }
        let elapsed = now().timeIntervalSince(lastPost)
        if elapsed < Self.throttle {
            guard cancelTrailing == nil else { return }
            cancelTrailing = schedule(Self.throttle - elapsed) { [weak self] in
                guard let self, let id = self.conversationId else { return }
                self.cancelTrailing = nil
                self.send(id, true)
            }
            return
        }
        cancelTrailing?()
        cancelTrailing = nil
        send(id, true)
    }

    /// The draft ended: sent, cleared, blurred, or the chat closed.
    func stop() {
        cancelTrailing?()
        cancelTrailing = nil
        guard let id = conversationId, active else { return }
        send(id, false)
    }

    private func send(_ id: String, _ value: Bool) {
        lastPost = now()
        active = value
        post(id, value)
    }
}
