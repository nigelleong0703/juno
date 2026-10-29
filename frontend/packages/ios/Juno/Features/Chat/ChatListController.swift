import ChatLayout
import SwiftUI
import UIKit

// The chat transcript, built the way Telegram does it: the collection view is flipped vertically and every cell is
// flipped back, so the newest row is item 0 at content offset 0 (the visual bottom). The composer/keyboard height is
// the list's top inset and the header the bottom inset (both in the flipped space); the list is anchored to the
// composer without any "scroll to bottom" correction. ChatLayout lays it out as a plain vertical list; one
// UIHostingController cell per entry so every SwiftUI bubble and card is reused.

/// What a cell needs from the screen: the hosted SwiftUI rows do not inherit its environment.
struct ChatContext {
    var world: World
    var conversationId: String
    var isGroup: Bool
    var accent: Color?
    var openRoute: (Route) -> Void
}

/// State shared between the SwiftUI chrome and the UIKit list.
@MainActor @Observable
final class ChatStore {
    var showJump = false
    /// The hosted composer's side inset (`ChatHostingController` drives it with the keyboard); nil where the composer draws itself.
    var composerSide: CGFloat?
    /// Bottom of the header bar and top of the composer in global coordinates; they become the list's insets.
    /// The composer's top is not observed: it moves every frame while the keyboard is dragged, and goes straight to the list.
    var headerBottom: CGFloat = 0
    @ObservationIgnored var composerTop: CGFloat = 0 {
        didSet { controller?.composerTop = composerTop }
    }
    /// How far the composer's top is above the list's bottom edge; the hosting controller sets it (with a transition).
    @ObservationIgnored private(set) var composerInset: CGFloat = 0
    @ObservationIgnored var keyboardDismissMode: UIScrollView.KeyboardDismissMode = .onDrag {
        didSet { controller?.setKeyboardDismissMode(keyboardDismissMode) }
    }
    /// The finger that just lowered the keyboard has been released: its scroll view must not fling.
    @ObservationIgnored var shouldStopScrolling: (() -> Bool)?
    func setComposerInset(_ inset: CGFloat, transition: ChatKeyboardTransition, scrollToNewest: Bool) {
        composerInset = inset
        controller?.setComposerInset(inset, transition: transition, scrollToNewest: scrollToNewest)
    }
    /// What the composer holds: its text, and its uploaded attachments and picked mentions (read when sending).
    var draft = ""
    var extras = ComposerExtras()
    /// What a "+" menu row asks the composer to do (it owns the pickers).
    var attach: AttachRequest?
    @ObservationIgnored weak var controller: ChatListController?
    #if DEBUG
    @ObservationIgnored var motionChrome: (() -> ChatMotionChrome?)?
    #endif

    func jumpToLatest() { controller?.jumpToLatest() }
}

enum AttachRequest { case camera, photos, files }

struct ChatListView: UIViewControllerRepresentable {
    let store: ChatStore
    let context: ChatContext
    let entries: [ChatEntry]

    func makeUIViewController(context: Context) -> ChatListController { ChatListController(store: store) }

    func updateUIViewController(_ controller: ChatListController, context: Context) {
        controller.context = self.context
        controller.headerBottom = store.headerBottom
        controller.composerTop = store.composerTop
        controller.update(entries)
    }
}

/// The row as a hosted cell: the width is the layout's, the height was worked out before the row was shown.
///
/// Per-cell `UIHostingController` with empty `safeAreaRegions`, matching the measuring host in `RowHeights`:
/// under the flipped list a configuration-hosted row inherited the screen safe area and drew offset from the
/// geometry it reported. `clipsToBounds` stays for the mid-collapse animation.
final class ChatCell: UICollectionViewCell {
    /// The bubble's rect in cell coordinates, reported by SwiftUI; the context menu lifts only this.
    var bubbleRect: CGRect = .zero
    /// The layout already has this row's exact height: no self-sizing pass.
    var isExact = false
    /// A row shown without a measured height sizes itself once; the list remembers the result.
    var onSelfSized: ((CGFloat) -> Void)?
    /// One SwiftUI tree per visible row, reused across `configure` calls.
    private var host: UIHostingController<AnyView>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        // A row collapsing shrinks its cell with the animation; what is still folding up must not spill onto the next row.
        clipsToBounds = true
        contentView.clipsToBounds = true
        // The list is flipped; the row is flipped back.
        contentView.transform = CGAffineTransform(scaleX: 1, y: -1)
        insetsLayoutMarginsFromSafeArea = false
        contentView.insetsLayoutMarginsFromSafeArea = false
        backgroundColor = .clear
        contentView.backgroundColor = .clear
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        if contentView.transform.d != -1 { UIView.performWithoutAnimation { contentView.transform = CGAffineTransform(scaleX: 1, y: -1) } }
    }

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        syncHostParent()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        syncHostParent()
    }

    override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        if isExact { return layoutAttributes }
        let attributes = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
        let size = contentView.systemLayoutSizeFitting(
            CGSize(width: layoutAttributes.size.width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel)
        attributes.size = CGSize(width: layoutAttributes.size.width, height: ceil(size.height))
        onSelfSized?(attributes.size.height)
        return attributes
    }

    func configure(_ entry: ChatEntry, context: ChatContext, width: CGFloat, exact: Bool,
                   resized: @escaping (CGFloat) -> Void, touched: @escaping () -> Void, selfSized: @escaping (CGFloat) -> Void) {
        contentView.transform = CGAffineTransform(scaleX: 1, y: -1)
        bubbleRect = .zero
        isExact = exact
        onSelfSized = selfSized
        contentConfiguration = nil
        let host = ensureHostView()
        syncHostParent()
        host.rootView = AnyView(
            chatRowContent(entry, context: context, width: width, bubble: { [weak self] rect in self?.bubbleRect = rect }, resized: resized, touched: touched)
                // A reused cell must not inherit the previous entry's @State; measuring hosts `.id` the same way.
                .id(entry.id)
                // Pinned to the cell's top, so a clipped row (mid-collapse) loses its bottom, not both ends.
                .frame(maxHeight: .infinity, alignment: .top)
        )
        // No `.ignoresSafeArea()`: the host contributes no safe area, so there is nothing to ignore.
    }

    /// The host on first use, pinned to the content view's own edges (never its safe-area guides).
    private func ensureHostView() -> UIHostingController<AnyView> {
        if let host = host { return host }
        let host = UIHostingController(rootView: AnyView(EmptyView()))
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        host.view.isOpaque = false
        host.view.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: contentView.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
        self.host = host
        return host
    }

    /// The nearest view controller above the cell adopts the host; off hierarchy the host is released so
    /// a retired cell is not kept alive by its old controller.
    private func syncHostParent() {
        guard let host = host, host.view.superview != nil else { return }
        var responder: UIResponder? = self
        while let current = responder {
            if let owner = current as? UIViewController {
                if host.parent !== owner {
                    host.willMove(toParent: nil)
                    host.removeFromParent()
                    owner.addChild(host)
                    host.didMove(toParent: owner)
                }
                return
            }
            responder = current.next
        }
        if host.parent != nil {
            host.willMove(toParent: nil)
            host.removeFromParent()
        }
    }
}

final class ChatListController: UIViewController {
    private let store: ChatStore
    private let chatLayout = CollectionViewChatLayout()
    private lazy var collectionView = UICollectionView(frame: .zero, collectionViewLayout: chatLayout)
    private let heights = RowHeights.shared
    /// The rows the list shows, in order; `models` by id. Updated right before a snapshot is applied, so the
    /// layout's `sizeForItem` always reads the state it is about to lay out.
    private var ids: [String] = []
    private var models: [String: ChatEntry] = [:]
    /// The latest entries SwiftUI handed over; `flush` brings the list to them.
    private var desired: [ChatEntry]?
    private var loaded = false
    /// Opening a chat settles for a moment: no insert animation while it does.
    private var loadedAt = Date.distantPast
    private var lastWidth: CGFloat = 0
    /// True while the reader is glued to the latest message; only the user's own scrolling clears it.
    private var pinned = true
    #if DEBUG
    private let motionTrace = ChatMotionTrace()
    #endif
    /// The exact height the layout holds per row. A row whose measured height differs gets reconfigured.
    private var layoutHeights: [String: CGFloat] = [:]
    private var measuring = false
    private var lastApplied = Date.distantPast
    private var throttled = false
    private var animatingInsert = false
    private var reported: [String: (ChatEntry, CGFloat)] = [:]
    private var reportWork: DispatchWorkItem?
    /// A tap inside a row opens a short window in which that row's height change is the user's toggle: it animates.
    private var toggleWindowEnd = Date.distantPast
    private var olderWork: DispatchWorkItem?

    var context: ChatContext?
    var headerBottom: CGFloat = 0 {
        didSet { if headerBottom != oldValue, isViewLoaded { applyInsets() } }
    }
    /// iPad and previews, where the composer is a SwiftUI bottom bar: its global top, turned into the inset.
    var composerTop: CGFloat = 0 {
        didSet {
            guard composerTop != oldValue, composerTop > 0, isViewLoaded else { return }
            setComposerInset(max(0, view.convert(view.bounds, to: nil).maxY - composerTop), transition: .immediate, scrollToNewest: false)
        }
    }
    /// The composer's (or keyboard's) height above the bottom edge: the list's top inset in the flipped space.
    private(set) var composerInset: CGFloat = 0
    private let container = UIView()

    private lazy var dataSource = ChatLayoutDiffableDataSource<Int, String>(
        collectionView: collectionView,
        cellProvider: { [weak self] collectionView, indexPath, id in
            // Never nil (the data source traps on it): a row asked for between a model swap and its snapshot is blank
            // for that one pass.
            let entry = self?.models[id] ?? ChatEntry(id: id, typingRunId: nil)
            guard let registration = self?.cellRegistration else { return UICollectionViewCell() }
            return collectionView.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: entry)
        }
    )
    /// Created before the first cell is dequeued (a registration made inside the cell provider asserts).
    private var cellRegistration: UICollectionView.CellRegistration<ChatCell, ChatEntry>!

    init(store: ChatStore) {
        self.store = store
        composerInset = store.composerInset
        super.init(nibName: nil, bundle: nil)
        store.controller = self
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        chatLayout.settings.interItemSpacing = 0
        // Flipped: the layout's top is the visual bottom (24pt plus the last row's own 6pt padding: ~30pt, which clears the composer edge effect's soft blur at rest), its bottom the visual top.
        chatLayout.settings.additionalInsets = UIEdgeInsets(top: 24, left: 0, bottom: 12, right: 0)
        // The bottom is offset 0 by construction: nothing to keep.
        chatLayout.keepContentOffsetAtBottomOnBatchUpdates = false
        chatLayout.keepContentAtBottomOfVisibleArea = false
        // Heights are exact: a row is not measured again after it appears (`rowReported` handles real changes).
        chatLayout.supportSelfSizingInvalidation = false
        chatLayout.delegate = self

        // The plain container is what animates as one layer when the composer moves; the flipped list sits inside it.
        container.frame = view.bounds
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(container)
        collectionView.frame = container.bounds
        collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collectionView.backgroundColor = .clear
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = store.keyboardDismissMode
        // Insets are ours: the header (visual top) and the composer or keyboard (visual bottom), in flipped space.
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.automaticallyAdjustsScrollIndicatorInsets = false
        collectionView.transform = CGAffineTransform(scaleX: 1, y: -1)
        // The status bar tap would scroll to the visual bottom (offset 0 is the newest end).
        collectionView.scrollsToTop = false
        collectionView.delegate = self
        // Half a second would feel dead; a third of one, and a moving finger is a scroll, not a press.
        let press = UILongPressGestureRecognizer(target: self, action: #selector(longPressed))
        press.minimumPressDuration = 0.35
        press.allowableMovement = 10
        collectionView.addGestureRecognizer(press)
        // Flipped: `top` is the composer's edge, `bottom` the header's. The composer edge stays plain (the newest row is never
        // smeared); the header keeps a soft edge so rows passing under the avatar stay readable against it.
        collectionView.topEdgeEffect.isHidden = true
        collectionView.bottomEdgeEffect.style = .soft
        container.addSubview(collectionView)
        cellRegistration = UICollectionView.CellRegistration<ChatCell, ChatEntry> { [weak self] cell, _, entry in
            guard let self, let context else { return }
            let width = collectionView.bounds.width
            cell.configure(entry, context: context, width: width, exact: heights.height(for: entry, width: width) != nil,
                           resized: { [weak self] height in self?.rowReported(entry, height) },
                           touched: { [weak self] in self?.toggleWindowEnd = Date().addingTimeInterval(0.6) },
                           selfSized: { [weak self] height in self?.heights.set(height, for: entry, width: width) })
        }
        _ = dataSource
    }

    func setKeyboardDismissMode(_ mode: UIScrollView.KeyboardDismissMode) {
        if isViewLoaded { collectionView.keyboardDismissMode = mode }
    }

    private var viewFrame: CGRect { view.convert(view.bounds, to: nil) }

    /// Telegram ListView's inset change (ListView.swift ~3272-3380). The composer (or keyboard) is the top inset in the
    /// flipped space. The offset follows it so the content stays glued to the composer, except under a finger (the reader
    /// holds the offset), and the whole list eases from where it was on screen with the one additive animation the
    /// composer uses: no per-row animation, no other transform.
    func setComposerInset(_ inset: CGFloat, transition: ChatKeyboardTransition, scrollToNewest: Bool) {
        let old = composerInset
        guard abs(inset - old) > 0.01 || scrollToNewest else { return }
        composerInset = inset
        guard isViewLoaded else { return }
        let before = collectionView.contentOffset.y
        let target = Self.offset(current: before, oldTop: old, newTop: inset, contentHeight: collectionView.contentSize.height,
                                 boundsHeight: collectionView.bounds.height, insetBottom: headerInset,
                                 tracking: collectionView.isTracking, scrollToNewest: scrollToNewest)
        UIView.performWithoutAnimation {
            setInsets()
            if collectionView.contentOffset.y != target { collectionView.contentOffset.y = target }
        }
        // The flipped list: a larger offset is content lower on screen, so the content moved by (new - old) and eases from -that.
        animateAdditiveY(container.layer, from: before - target, transition: transition)
    }

    /// Where the offset goes when the top inset changes from `oldTop` to `newTop`.
    static func offset(current: CGFloat, oldTop: CGFloat, newTop: CGFloat, contentHeight: CGFloat, boundsHeight: CGFloat,
                       insetBottom: CGFloat, tracking: Bool, scrollToNewest: Bool) -> CGFloat {
        var target = current
        if scrollToNewest {
            target = -newTop
        } else if !tracking {
            target = current - (newTop - oldTop)
        }
        let low = -newTop
        let high = max(low, contentHeight - boundsHeight + insetBottom)
        return min(max(target, low), high)
    }

    private var headerInset: CGFloat { max(0, headerBottom - viewFrame.minY) }

    /// The header is the bottom inset (the visual top), the composer the top one.
    private func setInsets() {
        let insets = UIEdgeInsets(top: composerInset, left: 0, bottom: headerInset, right: 0)
        if collectionView.contentInset != insets { collectionView.contentInset = insets }
        if collectionView.verticalScrollIndicatorInsets != insets { collectionView.verticalScrollIndicatorInsets = insets }
    }

    /// The header moved: only the bottom inset changes, the offset stays.
    private func applyInsets() {
        UIView.performWithoutAnimation { setInsets() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        applyInsets()
        let width = view.bounds.width
        if loaded, width > 0, width != lastWidth {
            // Heights belong to a width: measure again, then lay the rows out with them.
            lastWidth = width
            UIView.performWithoutAnimation { remeasureAll() }
        }
        lastWidth = width
        // Pending rows land without riding whatever animation this layout pass is part of (the keyboard's).
        UIView.performWithoutAnimation { flush() }
    }

    // MARK: Scroll state

    /// How far the reader is from the visual bottom (offset 0 plus the composer inset).
    private var distanceFromBottom: CGFloat { collectionView.contentOffset.y + collectionView.contentInset.top }
    /// For the keyboard controller: whether the reader is at the newest message when a touch begins.
    var distanceFromNewest: CGFloat { distanceFromBottom }
    private var isAtBottom: Bool { distanceFromBottom < 24 }

    /// Safety net: with exact heights the content height is final after one layout pass; if a pass still changes it
    /// (a row that measured differently from how it lays out), look again before showing the list.
    private func revealWhenSettled(lastHeight: CGFloat, tries: Int) {
        UIView.performWithoutAnimation { collectionView.layoutIfNeeded() }
        let height = collectionView.contentSize.height
        if height == lastHeight || tries >= 6 {
            UIView.animate(withDuration: 0.12) { self.collectionView.alpha = 1 }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + (tries == 0 ? 0 : 0.03)) { [weak self] in
                self?.revealWhenSettled(lastHeight: height, tries: tries + 1)
            }
        }
    }

    func scrollToBottom(animated: Bool) {
        pinned = true
        let y = -collectionView.contentInset.top
        let far = abs(y - collectionView.contentOffset.y) > collectionView.bounds.height * 1.5
        collectionView.setContentOffset(CGPoint(x: 0, y: y), animated: animated && !far)
    }

    /// The jump button: after reading far back (window trimmed at the newest end) the newest page comes back first.
    func jumpToLatest() {
        if let context, context.world.history[context.conversationId]?.detached == true {
            pinned = true
            context.world.reattach(context.conversationId)
            return
        }
        scrollToBottom(animated: true)
    }

    // MARK: Heights

    private var width: CGFloat { collectionView.bounds.width }

    /// Rows without a height for the current width/revision, newest first (the ones on screen come first).
    private func unmeasured() -> [ChatEntry] {
        (desired ?? []).filter { heights.height(for: $0, width: width) == nil }
    }

    /// Measures what is missing, newest first, in small slices between runloop turns (the reader's scrolling is never
    /// blocked for more than a few milliseconds), then brings the list up to date. One pass at a time.
    private func startMeasuring() {
        guard !measuring, let context else { return }
        measuring = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            let entries = desired ?? []
            await heights.measureAll(entries, context: context, width: width, enough: loaded ? nil : { [weak self] in self?.firstScreenReady() == true })
            measuring = false
            flush()
        }
    }

    /// The newest rows fill a screen and a half with measured heights (or everything is measured).
    private func firstScreenReady() -> Bool {
        var filled: CGFloat = 0
        for entry in desired ?? [] {
            guard let h = heights.height(for: entry, width: width) else { return false }
            filled += h
            if filled > view.bounds.height * 1.3 { return true }
        }
        return true
    }

    /// A row's content turned out different from what was measured (a card expanded, an image loaded): remember
    /// the real height and lay that row out again, once, without animation.
    private func rowReported(_ entry: ChatEntry, _ height: CGFloat) {
        guard height > 0, models[entry.id] == entry else { return }
        // The reader just tapped this row: its height follows the content's animation, right away.
        if Date() < toggleWindowEnd {
            let h = ceil(height)
            if let known = heights.height(for: entry, width: width), abs(known - h) <= 1 { return }
            heights.set(h, for: entry, width: width)
            // ChatLayout keeps its own copy of each size: only a reconfigure makes it ask `sizeForItem` again.
            animateLayout { [self] in
                guard var snapshot = dataSource.snapshot, snapshot.itemIdentifiers.contains(entry.id) else { return }
                snapshot.reconfigureItems([entry.id])
                dataSource.apply(snapshot, animatingDifferences: true, commitAlongsideUpdates: {}, completion: nil)
            }
            return
        }
        // Rows settle over a few passes (Textual fills its text in after the first): only where it ends up counts.
        reported[entry.id] = (entry, ceil(height))
        reportWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let settled = reported
            reported = [:]
            var changed: Set<String> = []
            for (id, (entry, height)) in settled where models[id] == entry {
                if let known = heights.height(for: entry, width: width), abs(known - height) <= 1 { continue }
                heights.set(height, for: entry, width: width)
                changed.insert(id)
            }
            if !changed.isEmpty { reconfigure(changed) }
        }
        reportWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    private func remeasureAll() { startMeasuring() }

    // MARK: Updates (stable ids, batch updates, reconfigure in place)

    /// `entries` come oldest first; the list holds them newest first (item 0 is the visual bottom).
    func update(_ entries: [ChatEntry]) {
        let next = Array(entries.reversed())
        // The same rows as last time (a header or composer change re-ran the view): nothing to diff.
        if next == lastEntries { return }
        lastEntries = next
        desired = next
        flush()
    }
    private var lastEntries: [ChatEntry]?

    private func flush() {
        guard isViewLoaded, view.bounds.width > 0, let next = desired, context != nil else { return }

        // History: the first non-empty list lands in one update, without animation, at the bottom.
        guard loaded else {
            guard !next.isEmpty else { return }
            // Only the first screenful is measured before the reveal; the rest follows in idle batches.
            guard firstScreenReady() else { startMeasuring(); return }
            loaded = true
            loadedAt = Date()
            lastApplied = Date()
            ids = next.map(\.id)
            models = Dictionary(next.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(ids)
            // History lands with no animation (this often runs inside the navigation push's animation block) and
            // stays hidden for the single layout pass that places it at the bottom.
            collectionView.alpha = 0
            UIView.performWithoutAnimation {
                applyInsets()
                dataSource.applySnapshotUsingReloadData(snapshot, commitAlongsideUpdates: {})
                collectionView.layoutIfNeeded()
                scrollToBottom(animated: false)
            }
            revealWhenSettled(lastHeight: -1, tries: 0)
            if !unmeasured().isEmpty { startMeasuring() }
            requestOlderIfNear()
            return
        }

        // Rows must have their height before they go in. A few are measured now; a whole page (older history)
        // is measured in idle batches first.
        if !unmeasured().isEmpty { startMeasuring(); return }

        let old = ids
        let before = models
        let nextIds = next.map(\.id)
        let nextModels = Dictionary(next.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        let changed = nextIds.filter { before[$0] != nil && before[$0] != nextModels[$0] }
        // Rows laid out with an estimate, or a height since replaced by a measured one.
        let stale = nextIds.filter { id in
            guard let entry = nextModels[id], let h = heights.height(for: entry, width: width) else { return false }
            return layoutHeights[id] != h && before[id] != nil
        }
        guard old != nextIds || !changed.isEmpty || !stale.isEmpty else { return }

        let inserted = nextIds.filter { before[$0] == nil }
        let appendOnly = !inserted.isEmpty && nextIds.count == old.count + inserted.count && Array(nextIds.suffix(old.count)) == old
        // A streaming message re-lays out at most every 100 ms.
        if inserted.isEmpty, old == nextIds, Date().timeIntervalSince(lastApplied) < 0.1 {
            if !throttled {
                throttled = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.throttled = false; self?.flush() }
            }
            return
        }
        // My own message always brings the list to the bottom; others only while the reader is there.
        if appendOnly, let last = next.first?.item, last.type == "user_message", last.authorId == context?.world.selfId { pinned = true }
        let wasAtBottom = pinned

        ids = nextIds
        models = nextModels
        lastApplied = Date()
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(nextIds)
        snapshot.reconfigureItems(Array(Set(changed + stale)))
        let animate = appendOnly && Date().timeIntervalSince(loadedAt) > 1.5 && inserted.count <= 3
        // Only a row's extras changed (a reaction, a run step), not its text: its height change animates.
        let resizeOnly = inserted.isEmpty && old == nextIds && Date().timeIntervalSince(loadedAt) > 1.5
            && !changed.isEmpty && changed.allSatisfy { before[$0]?.item == nextModels[$0]?.item }
        if resizeOnly {
            animateLayout { [self] in dataSource.apply(snapshot, animatingDifferences: true, commitAlongsideUpdates: {}, completion: nil) }
            requestOlderIfNear()
            return
        }
        animatingInsert = animate
        // A reader scrolled up keeps what they are looking at when a newer row lands at index 0.
        let anchor = (!wasAtBottom && !inserted.isEmpty && !inserted.contains { old.contains($0) }) ? chatLayout.getContentOffsetSnapshot(from: .top) : nil
        dataSource.apply(snapshot, animatingDifferences: animate, commitAlongsideUpdates: {}, completion: { [self] in
            animatingInsert = false
            if wasAtBottom, distanceFromBottom > 1 { scrollToBottom(animated: animate) }
        })
        if let anchor, !collectionView.isDragging, !collectionView.isDecelerating { chatLayout.restoreContentOffset(with: anchor) }
        requestOlderIfNear()
    }

    /// Lays the list out again inside an animation that matches the SwiftUI content's (0.25 s, no bounce): the
    /// changed row grows and the rows above it slide. The bottom is offset 0, so the list stays glued to the composer.
    private func animateLayout(_ changes: @escaping () -> Void) {
        guard loaded else { changes(); return }
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            changes()
            self.chatLayout.invalidateLayout()
            self.collectionView.layoutIfNeeded()
        }
    }

    /// Rows again, after their content or height changed without their entry changing (a reaction, a real height).
    func reconfigure(_ rowIds: Set<String>) {
        guard var snapshot = dataSource.snapshot else { return }
        let present = snapshot.itemIdentifiers.filter { rowIds.contains($0) }
        guard !present.isEmpty else { return }
        snapshot.reconfigureItems(present)
        UIView.performWithoutAnimation {
            dataSource.apply(snapshot, animatingDifferences: false, commitAlongsideUpdates: {}, completion: nil)
        }
    }

    // MARK: Paging

    /// Within a screen and a half of the visual top (the content's end): ask for the next older page (debounced; the world answers from the
    /// database first, then the server). Rows are measured before they are inserted, above the reader, held in place.
    private func requestOlderIfNear() {
        guard loaded, olderWork == nil, let context else { return }
        let maxOffset = collectionView.contentSize.height - collectionView.bounds.height + collectionView.contentInset.bottom
        guard maxOffset - collectionView.contentOffset.y < collectionView.bounds.height * 1.5 else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.olderWork = nil
            context.world.loadOlder(context.conversationId)
        }
        olderWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }
}

// MARK: Delegates

extension ChatListController: UICollectionViewDelegate {

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        #if DEBUG
        let cell = collectionView.visibleCells.min {
            (collectionView.indexPath(for: $0)?.item ?? Int.max) < (collectionView.indexPath(for: $1)?.item ?? Int.max)
        }
        let id = cell.flatMap { collectionView.indexPath(for: $0) }.flatMap { dataSource.itemIdentifier(for: $0) }
        motionTrace.begin { [weak self, weak cell] in
            guard let self, let frame = chatMotionFrame(collectionView) else { return nil }
            let currentId = cell.flatMap { collectionView.indexPath(for: $0) }.flatMap { dataSource.itemIdentifier(for: $0) }
            let bubble = (cell as? ChatCell).flatMap { chatMotionFrame($0.contentView, rect: $0.bubbleRect) }
            return ChatMotionSample(time: CACurrentMediaTime(),
                fingerY: collectionView.panGestureRecognizer.numberOfTouches > 0
                    ? collectionView.panGestureRecognizer.location(in: collectionView.window).y : nil,
                offsetY: collectionView.contentOffset.y,
                presentationOffsetY: collectionView.layer.presentation()?.bounds.minY ?? collectionView.bounds.minY,
                topInset: collectionView.contentInset.top, listFrame: frame,
                rowFrame: cell.flatMap { chatMotionFrame($0) }, bubbleFrame: bubble,
                rowStable: id != nil && currentId == id, chrome: store.motionChrome?())
        }
        #endif
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint,
                                  targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        // The same finger just lowered the keyboard: stop here, do not fling the transcript (Telegram shouldStopScrolling).
        if store.shouldStopScrolling?() == true { targetContentOffset.pointee = scrollView.contentOffset }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { pinned = isAtBottom }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        pinned = isAtBottom
    }

    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) { pinned = isAtBottom }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        // Scrolling by the reader's own hand (or a fling) is what unpins; a bounce back to the bottom pins again at rest.
        let show = distanceFromBottom > 140 || context?.world.history[context?.conversationId ?? ""]?.detached == true
        if store.showJump != show { store.showJump = show }
        requestOlderIfNear()
    }

    // MARK: Long press (WhatsApp-style: the bubble lifts, emoji above, actions below)

    @objc func longPressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, presentedViewController == nil,
              let indexPath = collectionView.indexPathForItem(at: gesture.location(in: collectionView)),
              let id = dataSource.itemIdentifier(for: indexPath), let item = models[id]?.item, let context,
              item.type == "user_message" || item.type == "agent_message",
              let cell = collectionView.cellForItem(at: indexPath) as? ChatCell, !cell.bubbleRect.isEmpty else { return }
        let rect = cell.bubbleRect
        let snapshot = UIGraphicsImageRenderer(size: rect.size).image { _ in
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: rect.size), cornerRadius: Radius.xxl).addClip()
            cell.contentView.drawHierarchy(in: CGRect(x: -rect.minX, y: -rect.minY, width: cell.contentView.bounds.width, height: cell.contentView.bounds.height), afterScreenUpdates: false)
        }
        let world = context.world
        let conversationId = context.conversationId
        let raw = item.type == "user_message" ? item.text : item.markdown
        let body = Quote.split(raw ?? "").body
        let copyText = body.isEmpty ? (raw ?? "") : body
        var actions = [
            ReactionAction(title: "Reply", symbol: "arrowshape.turn.up.left") { world.replyTo[conversationId] = item },
            ReactionAction(title: "Copy", symbol: "doc.on.doc") { UIPasteboard.general.string = copyText },
        ]
        if case .some(.some) = world.outbox[item.id] {
            actions.append(ReactionAction(title: "Retry", symbol: "arrow.clockwise") { world.retry(item.id, in: conversationId) })
            actions.append(ReactionAction(title: "Delete", symbol: "trash", destructive: true) { world.discard(item.id, in: conversationId) })
        }
        let sheet = ReactionSheet(
            snapshot: snapshot,
            frame: cell.contentView.convert(rect, to: nil),
            trailing: item.type == "user_message" && item.channelSender?.role != "stranger",
            mine: world.reactions[item.id],
            actions: actions,
            onReact: { emoji in world.react(item.id, emoji) },
            onClose: { [weak self] in self?.dismiss(animated: false) })
        let host = UIHostingController(rootView: sheet)
        host.view.backgroundColor = .clear
        host.modalPresentationStyle = .overFullScreen
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        present(host, animated: false)
    }
}

extension ChatListController: ChatLayoutDelegate {
    func sizeForItem(_ chatLayout: CollectionViewChatLayout, at indexPath: IndexPath) -> ItemSize {
        let width = collectionView.bounds.width
        guard indexPath.item < ids.count, let entry = models[ids[indexPath.item]], let height = heights.height(for: entry, width: width) else {
            if indexPath.item < ids.count { layoutHeights[ids[indexPath.item]] = nil }
            return .estimated(CGSize(width: width, height: 56))
        }
        layoutHeights[entry.id] = height
        return .exact(CGSize(width: width, height: height))
    }

    func alignmentForItem(_ chatLayout: CollectionViewChatLayout, at indexPath: IndexPath) -> ChatItemAlignment { .fullWidth }

    func initialLayoutAttributesForInsertedItem(_ chatLayout: CollectionViewChatLayout, at indexPath: IndexPath, modifying originalAttributes: ChatLayoutAttributes, on state: InitialAttributesRequestType) {
        // Only a live message slides in, never history (a page of older rows, the first load).
        guard animatingInsert else { return }
        originalAttributes.alpha = 0
        originalAttributes.transform = CGAffineTransform(translationX: 0, y: -36)
    }

    func finalLayoutAttributesForDeletedItem(_ chatLayout: CollectionViewChatLayout, at indexPath: IndexPath, modifying originalAttributes: ChatLayoutAttributes) {
        originalAttributes.alpha = 0
        originalAttributes.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
    }
}

extension EnvironmentValues {
    /// Set by the hosting cell: the bubble reports its frame (in the row's space) for the context-menu preview.
    @Entry var reportBubbleFrame: ((CGRect) -> Void)? = nil
}

extension EnvironmentValues {
    /// Set by the hosting cell: a tap landed in the row (it may be about to expand or collapse).
    @Entry var rowTouched: (() -> Void)? = nil
}

extension EnvironmentValues {
    /// Set by the hosting cell: the row reports its height; if it differs from the one the list measured (a card
    /// the reader expanded, an image that loaded) the list lays that row out again.
    @Entry var rowResized: ((CGFloat) -> Void)? = nil
}

#if DEBUG
struct ChatMotionChrome: Codable {
    let composer: CGRect
    let keyboard: CGRect?
}

struct ChatMotionSample: Codable {
    let time: TimeInterval
    let fingerY: CGFloat?
    let offsetY: CGFloat
    let presentationOffsetY: CGFloat
    let topInset: CGFloat
    let listFrame: CGRect
    let rowFrame: CGRect?
    let bubbleFrame: CGRect?
    let rowStable: Bool
    let chrome: ChatMotionChrome?
}

@MainActor
func chatMotionFrame(_ view: UIView, rect: CGRect? = nil) -> CGRect? {
    guard let window = view.window else { return nil }
    let layer = view.layer.presentation() ?? view.layer
    let destination = window.layer.presentation() ?? window.layer
    return layer.convert(rect ?? layer.bounds, to: destination)
}

/// Bounded, opt-in geometry recording. No row IDs, text, account or backend data leaves the probe.
@MainActor
private final class ChatMotionTrace {
    private let enabled = ProcessInfo.processInfo.environment["JUNO_CHAT_MOTION_TRACE"] == "1"
    private var link: CADisplayLink?
    private var probe: (() -> ChatMotionSample?)?
    private var samples: [ChatMotionSample] = []
    private var releasedAt: TimeInterval?
    private lazy var target = Target(owner: self)

    func begin(_ probe: @escaping () -> ChatMotionSample?) {
        guard enabled else { return }
        finish()
        self.probe = probe
        samples.removeAll(keepingCapacity: true)
        releasedAt = nil
        let link = CADisplayLink(target: target, selector: #selector(Target.tick))
        link.add(to: .main, forMode: .common)
        self.link = link
        tick()
    }

    private func tick() {
        guard let sample = probe?() else { finish(); return }
        samples.append(sample)
        if sample.fingerY == nil, releasedAt == nil { releasedAt = sample.time }
        if samples.count >= 360 || releasedAt.map({ sample.time - $0 >= 1.2 }) == true { finish() }
    }

    private func finish() {
        link?.invalidate(); link = nil
        probe = nil
        guard !samples.isEmpty else { return }
        struct Recording: Codable { let capturedAt: Date; let samples: [ChatMotionSample] }
        do {
            let folder = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true).appendingPathComponent("juno-chat-motion", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            try encoder.encode(Recording(capturedAt: Date(), samples: samples))
                .write(to: folder.appendingPathComponent("latest.json"), options: .atomic)
        } catch { print("CHAT_MOTION_TRACE|write failed|\(error.localizedDescription)") }
        samples.removeAll(keepingCapacity: true)
    }

    @MainActor private final class Target: NSObject {
        weak var owner: ChatMotionTrace?
        init(owner: ChatMotionTrace) { self.owner = owner }
        @objc func tick() { owner?.tick() }
    }
    isolated deinit { link?.invalidate() }
}
#endif
