import Foundation

/// What a chat knows about the history behind its in-memory window.
struct ChatHistory: Equatable {
    /// Keyset cursor of the page below the oldest STORED item (nil + reachedStart: that is the beginning).
    var olderCursor: String?
    var reachedStart = false
    /// The window was trimmed at its newest end (the reader went far back): live items go to the database only
    /// until `reattach` loads the newest page again.
    var detached = false
    var loadingOlder = false
}

extension Item {
    /// Transcript order: time, then id (the same order the database sorts by).
    static func isBefore(_ a: Item, _ b: Item) -> Bool { (a.at ?? .distantPast, a.id) < (b.at ?? .distantPast, b.id) }
}

// The chat reads memory that was loaded from the local database; the network only writes into the database and
// then into memory (Signal's MessageLoader / Telegram's MessageHistoryView). A chat is a bounded window anchored at
// its newest message, with older pages prepended on demand.
extension World {
    static let pageSize = 40
    /// In-memory window cap: paging further back drops the newest end (the chat is then `detached`).
    static let windowCap = 500
    static let hydratedChats = 12

    // MARK: Launch

    /// Everything the screens render from, straight from the device: the conversation list, the lists chat rows
    /// reference, and the newest page of each recently opened chat. No network. `present` shows the app now
    /// (a launch with a saved login); a fresh sign-in shows it after `connect` finishes.
    @MainActor
    func restore(_ session: Session, present: Bool) {
        let key = LocalStore.fileName(server: session.server, userId: session.userId)
        if storeKey != key {
            resetAccountState()
            store = LocalStore.open(session)
            storeKey = key
            selfId = session.userId
            if let store {
                conversations = store.conversations()
                agents = (store.blob("agents", as: [Agent].self) ?? []).map { var a = $0; if a.status == "working" { a.status = "idle" }; return a }
                runs = (store.blob("runs", as: [Run].self) ?? []).filter { $0.kind != "background" }
                requests = store.blob("requests", as: [AgentRequest].self) ?? []
                library = store.blob("library", as: [LibraryItem].self) ?? []
                routines = store.blob("routines", as: [Routine].self) ?? []
                for id in store.recentChats(limit: Self.hydratedChats) { hydrateChat(id) }
            }
        }
        if present {
            self.session = session
            api = API(session: session)
        }
    }

    /// Another account (or the demo) was in memory: nothing of it may stay.
    private func resetAccountState() {
        streamTask?.cancel()
        agents = []; members = []; conversations = []; items = [:]; history = [:]; itemsLoading = []; fetching = [:]
        runs = []; plans = []; requests = []; library = []; routines = []; skills = []; rules = []; activity = ActivityLog()
        computers = []; usage = nil; goals = []; ideas = []; feed = []; doing = [:]; attachments = [:]
        apps = nil; appDetails = [:]; appsLoadFailed = false
        tasks = [:]; planItems = [:]; decided = [:]; grants = [:]; screenElements = [:]; scope = nil
        displayIds = [:]; outbox = [:]
        aguiStreaming = [:]; controlEpochs = [:]
    }

    // MARK: Opening a chat

    /// Memory from the database: instant, no network. False when nothing is stored for the chat yet.
    @discardableResult @MainActor
    func hydrateChat(_ id: String) -> Bool {
        guard items[id] == nil, let store, let state = store.chatState(id) else { return items[id] != nil }
        items[id] = store.newest(id, limit: Self.pageSize)
        history[id] = ChatHistory(olderCursor: state.olderCursor, reachedStart: state.reachedStart)
        return true
    }

    /// A chat is about to be shown: from the database when its newest page is there, else one page from the server.
    @MainActor
    func loadItems(_ conversationId: String) {
        guard api != nil else { return }
        store?.touch(conversationId)
        guard items[conversationId] == nil, !itemsLoading.contains(conversationId) else { return }
        if hydrateChat(conversationId) { return }
        itemsLoading.insert(conversationId)
        Task { await fetchNewest(conversationId) }
    }

    /// GET the newest page (desc, one screen and a half), store it, and make it the chat's window. Items that arrived
    /// live meanwhile are merged in, so nothing between the response and now is lost.
    @MainActor
    func fetchNewest(_ id: String) async {
        guard let api, fetching[id] == nil else { return }
        fetching[id] = []
        defer { fetching[id] = nil; itemsLoading.remove(id) }
        do {
            let page = try await api.page("/v1/conversations/\(id)/items?order=desc&limit=\(Self.pageSize)", as: Item.self)
            var byId: [String: Item] = [:]
            for item in page.items + (fetching[id] ?? []) { byId[item.id] = item }
            let list = byId.values.sorted(by: Item.isBefore)
            store?.replaceNewest(id, items: list, olderCursor: page.next)
            // Messages of mine the server has not accepted yet are not in the page: they stay at the end.
            let unsent = (items[id] ?? []).filter { outbox[$0.id] != nil && byId[$0.id] == nil }
            items[id] = list + unsent
            history[id] = ChatHistory(olderCursor: page.next, reachedStart: page.next == nil)
        } catch {
            if items[id] == nil, !error.isCancellation { syncError = error.localizedDescription }
        }
    }

    /// First install, a missing cursor, or a `reset`: the newest page of the recently active chats, the open one first.
    @MainActor
    func seedRecentChats() async {
        var ids = conversations.sorted { ($0.lastItemAt ?? .distantPast) > ($1.lastItemAt ?? .distantPast) }.prefix(Self.hydratedChats).map(\.id)
        if let open = currentConversationId { ids.removeAll { $0 == open }; ids.insert(open, at: 0) }
        for id in ids where conversation(id) != nil { await fetchNewest(id) }
    }

    // MARK: Paging

    /// The reader is near the top: prepend the next older page, from the database first, then from the server.
    @MainActor
    func loadOlder(_ id: String) {
        guard let oldest = items[id]?.first(where: { outbox[$0.id] == nil }), var h = history[id], !h.loadingOlder else { return }
        let stored = store?.older(id, than: oldest, limit: Self.pageSize) ?? []
        if stored.isEmpty, h.reachedStart || h.olderCursor == nil || api == nil { return }
        if !stored.isEmpty { prepend(stored, to: id); return }
        h.loadingOlder = true
        history[id] = h
        let cursor = h.olderCursor ?? ""
        Task { @MainActor in
            defer { history[id]?.loadingOlder = false }
            let encoded = cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cursor
            guard let api, let page = try? await api.page("/v1/conversations/\(id)/items?order=desc&limit=\(Self.pageSize)&cursor=\(encoded)", as: Item.self) else { return }
            let older = page.items.sorted(by: Item.isBefore)
            store?.appendOlder(id, items: older, olderCursor: page.next)
            history[id]?.olderCursor = page.next
            history[id]?.reachedStart = page.next == nil
            prepend(older, to: id)
        }
    }

    @MainActor
    private func prepend(_ older: [Item], to id: String) {
        let have = Set((items[id] ?? []).map(\.id))
        let fresh = older.filter { !have.contains($0.id) }
        guard !fresh.isEmpty else { return }
        items[id] = fresh + (items[id] ?? [])
        if let extra = items[id]?.count, extra > Self.windowCap {
            items[id]?.removeLast(extra - Self.windowCap)
            history[id]?.detached = true
        }
    }

    /// Back to the newest end after reading far back: the newest page again, from the database.
    @MainActor
    func reattach(_ id: String) {
        guard history[id]?.detached == true, let store else { return }
        let unsent = (items[id] ?? []).filter { outbox[$0.id] != nil }
        items[id] = store.newest(id, limit: Self.pageSize) + unsent
        history[id]?.detached = false
    }

    // MARK: Live items

    /// An `item.added` event: into the database, then into memory (replacing an item that changed, e.g. a plan).
    @MainActor
    func receive(_ item: Item, in c: String) {
        // A stable composer id makes the product echo the acknowledgement of an AG-UI run start.
        if item.type == "user_message", outbox[item.id] != nil { outbox[item.id] = nil }
        if fetching[c] != nil { fetching[c]?.append(item) } else { store?.upsertLive(c, [item]) }
        guard items[c] != nil, history[c]?.detached != true else { return }
        if let i = items[c]?.firstIndex(where: { $0.id == item.id }) {
            if items[c]?[i] != item { items[c]?[i] = item }
        } else {
            items[c]?.append(item)
            if let count = items[c]?.count, count > Self.windowCap { items[c]?.removeFirst(count - Self.windowCap) }
        }
        if c == currentConversationId, appActive { scheduleMarkRead(c) }
    }

    // MARK: Persistence

    /// The stream cursor, written at most twice a second.
    @MainActor
    func noteCursor(_ id: Int) {
        lastCursor = id
        guard cursorTask == nil else { return }
        cursorTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(500))
            cursorTask = nil
            if let lastCursor { store?.setCursor(lastCursor) }
        }
    }

    @MainActor
    func persistConversationsSoon() {
        guard store != nil, conversationsSaveTask == nil else { return }
        conversationsSaveTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            conversationsSaveTask = nil
            store?.saveConversations(conversations)
        }
    }

    @MainActor
    func persistSnapshot() {
        guard let store else { return }
        store.saveConversations(conversations)
        store.saveBlob("agents", agents)
        store.saveBlob("runs", runs)
        store.saveBlob("requests", requests)
        store.saveBlob("library", library)
        store.saveBlob("routines", routines)
    }

    /// The server's log no longer reaches our cursor: stored history may have holes, so it starts over from the
    /// newest pages. What is open stays on screen until its fresh page replaces it.
    @MainActor
    func handleReset() async {
        store?.wipeHistory()
        lastCursor = nil
        items = items.filter { $0.key == currentConversationId }
        history = history.filter { $0.key == currentConversationId }
        aguiStreaming = [:]
        await refreshRequests()
        await seedRecentChats()
    }
}
