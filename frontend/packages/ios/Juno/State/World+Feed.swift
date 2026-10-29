import Foundation

/// The feed, feedback on a post and the server's Today (BACKEND §10.10b).
extension World {
    // MARK: Today

    /// Re-reads GET /v1/today, a moment after the last change so a burst of events is one request.
    func scheduleTodayRefresh(now: Bool = false) {
        guard let api else { return }
        todayTask?.cancel()
        todayTask = Task { @MainActor in
            if !now { try? await Task.sleep(for: .milliseconds(600)) }
            guard !Task.isCancelled else { return }
            if let today = try? await api.get("/v1/today", as: Contract.Today.self) { todayRemote = today }
        }
    }

    // MARK: Feed

    func reloadFeed() async {
        guard let api, let fresh = try? await api.list("/v1/feed?limit=100", as: FeedPost.self) else { return }
        feed = Self.newestFirst(fresh)
        scheduleTodayRefresh()
    }

    /// POST /v1/feed/:id/feedback: "more" or "less" like this post, with why when it is "less" (contracts 0.19 `reason`, `note`).
    /// Tapping the one already chosen is the same call.
    func sendFeedback(_ postId: String, _ signal: Contract.FeedbackSignal, reason: String? = nil, note: String? = nil) {
        if let i = feed.firstIndex(where: { $0.id == postId }) { feed[i].feedback = signal.rawValue }
        struct Body: Encodable { var signal: String; var reason: String?; var note: String? }
        remote { api in
            let data = try await api.post("/v1/feed/\(postId)/feedback", Body(signal: signal.rawValue, reason: reason, note: note))
            if let post = try? isoDecoder.decode(FeedPost.self, from: data), let i = self.feed.firstIndex(where: { $0.id == post.id }) { self.feed[i] = post }
        }
    }

    /// Replying to or forwarding a post says it was interesting: "more", once and without a word.
    func noteInterest(_ post: FeedPost) {
        if post.feedback != "more" { sendFeedback(post.id, .more) }
    }

    /// "Not for me" with a reason: the post disappears now; the server is told after a few seconds unless Undo is tapped.
    func dismissPost(_ post: FeedPost, reason: String, note: String? = nil) {
        guard let i = feed.firstIndex(where: { $0.id == post.id }) else { return }
        if let pending = feedToast { flushToast(pending) }
        let toast = FeedToast(postId: post.id, previous: feed[i].feedback, reason: reason, note: note,
                              text: "Got it. \(agent(post.agentId)?.name ?? "Your agent") will adjust what it posts.")
        feed[i].feedback = "less"
        feedToast = toast
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(5))
            if feedToast?.id == toast.id { flushToast(toast) }
        }
    }

    func undoDismiss() {
        guard let toast = feedToast else { return }
        feedToast = nil
        if let i = feed.firstIndex(where: { $0.id == toast.postId }) { feed[i].feedback = toast.previous }
    }

    private func flushToast(_ toast: FeedToast) {
        if feedToast?.id == toast.id { feedToast = nil }
        sendFeedback(toast.postId, .less, reason: toast.reason, note: toast.note)
    }
}

struct FeedToast: Identifiable, Equatable {
    let id = UUID()
    var postId: String
    var previous: String?
    var reason: String
    var note: String?
    var text: String
}

struct ProactiveToast: Identifiable, Equatable {
    let id = UUID()
    var text: String
    /// The rule the choice made; Undo deletes it. nil for "Not now", which has nothing to undo.
    var ruleId: String?
}
