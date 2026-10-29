import Foundation
import Observation

/// One open document (web: components/document/useDocumentSession.ts). It loads the Markdown to show (the open draft, else the
/// saved head), autosaves the owner's edits to `PUT …/draft` with the revision it loaded, and decides the draft. A 409 never
/// overwrites anything: the local text stays and `saveState` is `.conflict` until the owner reloads.
@MainActor @Observable
final class DocumentSession {
    enum SaveState { case idle, saving, saved, conflict, error }
    enum Busy { case approving, declining }
    struct Loaded: Equatable { var markdown: String; var key: Int }

    /// How long after the last edit the text is saved as a draft.
    static let autosaveDelay: Duration = .seconds(1.2)

    let id: String
    private let world: World

    private(set) var view: DocView?
    private(set) var loaded: Loaded?
    private(set) var headMarkdown: String?
    private(set) var loadFailed = false
    private(set) var dirty = false
    private(set) var saveState: SaveState = .idle
    private(set) var busy: Busy?
    private(set) var actionError: String?
    private(set) var text = ""

    // What the server holds, as this session knows it.
    @ObservationIgnored private var revision: Int?
    @ObservationIgnored private var draftId: String?
    @ObservationIgnored private var baseVersion = 0
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var inFlight: Task<Bool, Never>?
    @ObservationIgnored private var conflict = false
    @ObservationIgnored private var reloading = false
    @ObservationIgnored private var generation = 0

    init(id: String, world: World) {
        self.id = id
        self.world = world
    }

    var draft: DocDraft? { view?.openDraft }
    var headVersion: Int { view?.headVersion ?? 0 }
    /// An agent's proposal nobody has edited: reviewed with Approve & save / Decline.
    var isReview: Bool { draft?.author?.agentId != nil && !dirty }
    var canCompare: Bool { draft != nil && headVersion >= 1 && headMarkdown != nil }

    // MARK: Loading

    func start() async { await reload() }

    /// Fetch the document again and make what the server holds the editor's baseline.
    func reload() async {
        guard !reloading else { return }
        reloading = true
        defer { reloading = false }
        do {
            let next = try await world.loadDocument(id)
            view = next
            let head = next.headVersion
            headMarkdown = head >= 1 ? try await world.documentVersion(id, version: head) : ""
            if let open = next.openDraft {
                let body = try await world.documentDraft(id)
                adopt(body.markdown, draft: open.id == body.draft.id ? body.draft : open, head: head)
            } else {
                adopt(headMarkdown ?? "", draft: nil, head: head)
            }
            loadFailed = false
        } catch {
            if loaded == nil { loadFailed = true } else { actionError = error.localizedDescription }
        }
    }

    private func adopt(_ markdown: String, draft: DocDraft?, head: Int) {
        timer?.cancel()
        text = markdown
        dirty = false
        conflict = false
        revision = draft?.revision
        draftId = draft?.id
        baseVersion = head
        generation += 1
        saveState = .idle
        loaded = Loaded(markdown: markdown, key: generation)
    }

    /// The cached document moved without us (an agent replaced its draft, another device saved): follow it unless mid-edit.
    func follow() {
        guard loaded != nil, !dirty, inFlight == nil, busy == nil, let cached = world.documents[id] else { return }
        view = cached
        let moved = cached.openDraft?.id != draftId || cached.openDraft?.revision != revision || cached.headVersion != baseVersion
        if moved { Task { await reload() } }
    }

    // MARK: Editing

    func edit(_ markdown: String) {
        guard markdown != text else { return }
        text = markdown
        dirty = true
        actionError = nil
        scheduleAutosave()
    }

    private func scheduleAutosave() {
        timer?.cancel()
        guard !conflict else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: Self.autosaveDelay)
            guard !Task.isCancelled else { return }
            _ = await self?.save()
        }
    }

    /// Save the waiting edit as a draft; true when nothing is left unsaved.
    @discardableResult
    func save() async -> Bool {
        if let running = inFlight { _ = await running.value }
        guard dirty else { return !conflict }
        guard !conflict else { return false }
        let sent = text
        let title = view?.draft?.title ?? view?.document.name ?? "Untitled"
        saveState = .saving
        let run = Task { [weak self] () -> Bool in
            guard let self else { return false }
            do {
                let saved = try await self.world.saveDocumentDraft(self.id, title: title, markdown: sent, expectedRevision: self.revision, baseVersion: self.revision == nil ? self.baseVersion : nil)
                self.revision = saved.draft.revision
                self.draftId = saved.draft.id
                if var current = self.view { current.draft = saved.draft; self.view = current; self.world.documents[self.id] = current }
                if self.text == sent {
                    self.dirty = false
                    self.saveState = .saved
                } else {
                    self.scheduleAutosave()
                }
                return true
            } catch {
                self.conflict = (error as? APIError)?.status == 409
                self.saveState = self.conflict ? .conflict : .error
                if !self.conflict { self.actionError = error.localizedDescription }
                return false
            }
        }
        inFlight = run
        let ok = await run.value
        inFlight = nil
        return ok
    }

    // MARK: Deciding

    /// Approve: the owner's own save, or the agent's proposal as it stands. Saves what is waiting first.
    func approve() async {
        actionError = nil
        busy = .approving
        defer { busy = nil }
        guard await save(), let open = world.documents[id]?.openDraft ?? draft else { return }
        do {
            let next = try await world.decideDocumentDraft(id, draftId: open.id, revision: revision ?? open.revision, approve: true)
            revision = nil
            draftId = nil
            baseVersion = next.headVersion
            view = next
            headMarkdown = text
            saveState = .saved
        } catch { failed(error) }
    }

    func decline() async {
        actionError = nil
        busy = .declining
        defer { busy = nil }
        timer?.cancel()
        if let running = inFlight { _ = await running.value }
        guard let open = world.documents[id]?.openDraft ?? draft else { return }
        do {
            try await world.decideDocumentDraft(id, draftId: open.id, revision: revision ?? open.revision, approve: false)
            dirty = false
            await reload()
        } catch { failed(error) }
    }

    /// A 409 keeps the text and asks for a reload; anything else (an external target that is not connected yet answers
    /// 501 EXTERNAL_TARGET_UNAVAILABLE) shows the server's own message and leaves the draft as it is.
    private func failed(_ error: Error) {
        if (error as? APIError)?.status == 409 {
            conflict = true
            saveState = .conflict
        } else {
            actionError = error.localizedDescription
        }
    }

    /// Closing the viewer saves what still waits in the debounce.
    func finish() {
        timer?.cancel()
        if dirty { Task { _ = await save() } }
    }
}
