import SwiftUI
import UIKit

// Layout reference: WhatsApp chat list (search, filter chips, pinned first, swipe actions). A native
// UINavigationController (scroll-edge effect) around a UICollectionView list with a
// diffable data source, because SwiftUI List cannot slide a row from its old index to its new one.

private enum ChatFilter: Hashable {
    case all, unread, needsYou, groups
    /// Every conversation on one messaging platform (own DM, groups, strangers).
    case platform(ChannelPlatform)

    static let base: [ChatFilter] = [.all, .unread, .needsYou, .groups]

    var title: String {
        switch self {
        case .all: "All"
        case .unread: "Unread"
        case .needsYou: "Needs you"
        case .groups: "Groups"
        case .platform(let p): p == .feishu ? "Feishu" : p.name
        }
    }
}

/// The Chats tab root: filter chips, then every chat (pinned, then most recent). The navigation controller around it
/// owns the bar buttons and the push of a chat.
@MainActor
final class ChatListViewController: UICollectionViewController {
    private let world: World
    private let coordinator: ChatCollectionCoordinator
    private var filter = ChatFilter.all
    private let query = ""
    private var generation = 0
    private weak var newChatHost: UIViewController?
    private let todayLayout = TodayLayout()
    private let titleLabel = UILabel()

    init(world: World) {
        self.world = world
        let coordinator = ChatCollectionCoordinator()
        self.coordinator = coordinator
        super.init(collectionViewLayout: coordinator.makeLayout())
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Not `title`: on a navigation controller that also becomes the tab bar item's label, and the bar is icon-only.
        // The greeting is the page's heading; "Chats" fades into the bar's centre once it has scrolled away.
        navigationItem.largeTitleDisplayMode = .never
        titleLabel.text = "Chats"
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = UIColor(Theme.fg)
        titleLabel.sizeToFit()
        navigationItem.titleView = titleLabel
        syncTitle()
        collectionView.backgroundColor = UIColor(Theme.canvas)
        collectionView.topEdgeEffect.style = .soft
        collectionView.delegate = coordinator
        coordinator.world = world
        coordinator.todayLayout = todayLayout
        coordinator.onOpen = { [world] in world.currentConversationId = $0 }
        coordinator.onDelete = { [weak self] in self?.confirmDelete($0) }
        coordinator.onFilter = { [weak self] in self?.filter = $0; self?.refresh() }
        coordinator.onScroll = { [weak self] _ in self?.syncTitle() }
        coordinator.attach(collectionView)

        let menu = UIBarButtonItem(image: UIImage(systemName: "line.3.horizontal"), primaryAction: UIAction { [world] _ in
            withAnimation(.snappy(duration: 0.28)) { world.sidebarOpen = true }
        })
        menu.accessibilityLabel = "Menu"
        navigationItem.leftBarButtonItem = menu
        let compose = UIBarButtonItem(image: UIImage(systemName: "square.and.pencil"), primaryAction: UIAction { [weak self] _ in
            self?.newChat()
        })
        compose.accessibilityLabel = "New chat"
        let search = UIBarButtonItem(image: UIImage(systemName: "magnifyingglass"), primaryAction: UIAction { [weak self] _ in
            self?.openSearch()
        })
        search.accessibilityLabel = "Search"
        search.accessibilityIdentifier = "chat-search"
        // Two separate items, so each keeps its own glass capsule.
        navigationItem.rightBarButtonItems = [compose, .fixedSpace(0), search]
        refresh()
    }

    /// The title's alpha is a pure function of the list's offset from its resting position; it is never "visible by default".
    private func syncTitle() {
        // Under a presented page (search) or while it leaves, the bar and the insets are in flux: keep the alpha as it was.
        guard presentedViewController == nil else { return }
        let scrolled = max(0, collectionView.contentOffset.y + collectionView.adjustedContentInset.top)
        titleLabel.alpha = min(1, max(0, (scrolled - 36) / 36))
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        syncTitle()
        transitionCoordinator?.animate(alongsideTransition: { [weak self] _ in self?.syncTitle() }, completion: { [weak self] _ in self?.syncTitle() })
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        syncTitle()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncTitle()
    }

    /// The platforms that have at least one conversation, in the platforms' own order.
    private var platforms: [ChannelPlatform] {
        let present = Set(world.sortedConversations.compactMap { ChannelPlatform(kind: $0.channel?.kind) })
        return ChannelPlatform.allCases.filter(present.contains)
    }

    private var visible: [Conversation] {
        world.sortedConversations.filter { c in
            switch filter {
            case .all: !c.isChannelChat && c.kind != "task"
            case .unread: (c.unreadCount ?? 0) > 0
            case .needsYou: !world.needsYou(in: c.id).isEmpty
            case .groups: c.channel == nil && (c.kind == "room" || c.kind == "peer")
            case .platform(let p): ChannelPlatform(kind: c.channel?.kind) == p
            }
        }
        .filter {
            query.isEmpty || ConversationRow.title($0, world).localizedCaseInsensitiveContains(query)
                || ($0.lastMessagePreview ?? "").localizedCaseInsensitiveContains(query)
        }
    }

    /// Re-registers what the list reads (the filter changes what that is) and applies the current state. A change in
    /// World calls this again; older registrations see a newer generation and do nothing.
    private func refresh() {
        // A platform chip whose chats are all gone falls back to All.
        if case .platform(let p) = filter, !platforms.contains(p) { filter = .all }
        generation += 1
        let mine = generation
        withObservationTracking {
            _ = visible
            _ = world.currentConversationId
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.refresh()
            }
        }
        coordinator.update(rows: visible, filter: filter, platforms: platforms, selected: world.currentConversationId, query: query)
    }

    /// The same full-screen search the sidebar opens.
    private func openSearch() {
        let host = UIHostingController(rootView: SearchPage().environment(world))
        host.modalPresentationStyle = .fullScreen
        present(host, animated: true)
    }

    private func newChat() {
        let host = UIHostingController(rootView: NewChatSheet { [weak self] id in
            self?.newChatHost?.dismiss(animated: true) { [world = self?.world] in world?.openChat(id) }
        }.environment(world))
        newChatHost = host
        present(host, animated: true)
    }

    private func confirmDelete(_ c: Conversation) {
        let sheet = UIAlertController(title: "Delete this chat?", message: "The messages in it are removed for good.", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Delete", style: .destructive) { [world] _ in world.deleteConversation(c.id) })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        present(sheet, animated: true)
    }
}

/// The pinned header over the chats: the filter chips, with a count on the Needs-you chip; while the Today block
/// that holds them is scrolled out of view, that chip scrolls back to it.
private struct ChatsHeader: View {
    var state: FilterState
    var select: (ChatFilter) -> Void
    @Environment(World.self) private var world
    @Environment(TodayLayout.self) private var layout

    var body: some View {
        let count = world.today.needsYouCount
        ScrollView(.horizontal, showsIndicators: false) {
            GlassEffectContainer(spacing: 6) {
            HStack(spacing: 6) {
                // The fixed chips, then one per messaging platform that has chats.
                ForEach(ChatFilter.base + state.platforms.map(ChatFilter.platform), id: \.self) { f in
                    let badge = f == .needsYou && count > 0
                    Button {
                        select(f)
                    } label: {
                        HStack(spacing: 5) {
                            if case .platform(let p) = f { ChannelBadge(platform: p, size: 16) }
                            Text(f.title).text(.sm, .medium)
                            if badge {
                                HStack(spacing: 4) {
                                    Circle().fill(Theme.warning).frame(width: 7, height: 7)
                                    Text("\(count)").text(.sm, .semibold)
                                }
                                .accessibilityIdentifier("needs-you-pill")
                            }
                        }
                        .padding(.horizontal, 12).frame(height: 28)
                        .foregroundStyle(state.filter == f ? Theme.primaryFg : Theme.fg)
                        .modifier(ChipSurface(selected: state.filter == f, floating: layout.chipsPinned))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
            }
        }
        // No band behind the pinned chips: like the nav bar's buttons, they float over the list as glass capsules.
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeOut(duration: 0.15), value: layout.chipsPinned)
    }
}

/// A chip's capsule: solid when selected; at rest a muted fill, and glass while pinned over the scrolling chats.
private struct ChipSurface: ViewModifier {
    var selected: Bool
    var floating: Bool
    func body(content: Content) -> some View {
        if selected {
            content.background(Theme.primary, in: .capsule)
        } else if floating {
            content.glassEffect(.regular.interactive(), in: .capsule)
        } else {
            content.background(Theme.muted, in: .capsule)
        }
    }
}

/// The selected filter, read by the pinned header (a supplementary view is not reconfigured by a snapshot).
@Observable private final class FilterState {
    var filter = ChatFilter.all
    var platforms: [ChannelPlatform] = []
}

@MainActor
private final class ChatCollectionCoordinator: NSObject, UICollectionViewDelegate {
    private static let emptyId = "~empty", anotherId = "~another"
    private enum Section {
        case chats
    }

    var world: World!
    var todayLayout: TodayLayout!
    var onScroll: ((CGFloat) -> Void)?
    private let filterState = FilterState()
    /// The pinned chips header is on unless there is nothing to chat in yet (a new user's Today is the whole screen).
    private var showsHeader = true
    var onOpen: (String) -> Void = { _ in }
    var onDelete: (Conversation) -> Void = { _ in }
    var onFilter: (ChatFilter) -> Void = { _ in }

    private weak var collectionView: UICollectionView?
    private var dataSource: UICollectionViewDiffableDataSource<Section, String>!
    private var byId: [String: Conversation] = [:]
    private var rows: [Conversation] = []
    private var filter = ChatFilter.all
    private var query = ""
    private var selected: String?
    private var emptyText = "Nothing here"
    private var loaded = false
    private var pending: Task<Void, Never>?

    func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { [weak self] section, environment in
            var config = self?.listConfiguration() ?? UICollectionLayoutListConfiguration(appearance: .plain)
            // Plain-style headers stay at the top of the list while their section scrolls.
            config.headerMode = section == 0 && self?.showsHeader == true ? .supplementary : .none
            return NSCollectionLayoutSection.list(using: config, layoutEnvironment: environment)
        }
    }

    private func listConfiguration() -> UICollectionLayoutListConfiguration {
        var config = UICollectionLayoutListConfiguration(appearance: .plain)
        config.backgroundColor = .clear
        config.showsSeparators = true
        // The default adds space above a section header: it showed as a gap above the pinned chips.
        config.headerTopPadding = 0
        config.itemSeparatorHandler = { [weak self] path, base in
            var s = base
            guard let id = self?.dataSource.itemIdentifier(for: path), !id.hasPrefix("~") else {
                s.topSeparatorVisibility = .hidden; s.bottomSeparatorVisibility = .hidden
                return s
            }
            s.topSeparatorVisibility = .hidden
            s.bottomSeparatorInsets = NSDirectionalEdgeInsets(top: 0, leading: 64, bottom: 0, trailing: 0)
            return s
        }
        config.leadingSwipeActionsConfigurationProvider = { [weak self] in self?.leadingActions($0) }
        config.trailingSwipeActionsConfigurationProvider = { [weak self] in self?.trailingActions($0) }
        return config
    }

    func attach(_ cv: UICollectionView) {
        collectionView = cv
        let header = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(elementKind: UICollectionView.elementKindSectionHeader) { [weak self] cell, _, _ in
            guard let self else { return }
            guard let world = self.world, let layout = self.todayLayout else { return }
            let state = self.filterState, select = self.onFilter
            cell.backgroundConfiguration = .clear()
            cell.contentConfiguration = UIHostingConfiguration { ChatsHeader(state: state, select: select).environment(world).environment(layout) }.margins(.horizontal, 16).margins(.vertical, 0)
        }
        let another = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, _ in
            guard let world = self?.world else { return }
            cell.backgroundConfiguration = .clear()
            cell.contentConfiguration = UIHostingConfiguration {
                Button { world.sheet = .newAgent } label: {
                    HStack(spacing: 6) {
                        Text("Talk to another agent").text(.base)
                        Image(systemName: "arrow.right").text(.sm, .medium)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.fgSubtle)
                    .padding(.vertical, 14)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-another-agent")
            }.margins(.horizontal, 16).margins(.vertical, 0)
        }
        let row = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
            guard let self else { return }
            // Transparent unless highlighted: opaque rows would cover the moving row on its way to its new place.
            cell.configurationUpdateHandler = { cell, state in
                var bg = UIBackgroundConfiguration.clear()
                if state.isHighlighted || state.isSelected { bg.backgroundColor = UIColor(Theme.muted) }
                cell.backgroundConfiguration = bg
            }
            guard let c = self.byId[id] else { cell.contentConfiguration = nil; return }
            let world = self.world!
            cell.contentConfiguration = UIHostingConfiguration {
                ConversationRow(conversation: c).environment(world)
            }
            .margins(.horizontal, 16).margins(.vertical, 0)
        }
        let empty = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, _ in
            let text = self?.emptyText ?? ""
            cell.backgroundConfiguration = .clear()
            cell.contentConfiguration = UIHostingConfiguration {
                ContentUnavailableView(text, systemImage: "bubble.left.and.bubble.right").frame(minHeight: 320)
            }
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: cv) { cv, path, id in
            switch id {
            case Self.anotherId: cv.dequeueConfiguredReusableCell(using: another, for: path, item: id)
            case Self.emptyId: cv.dequeueConfiguredReusableCell(using: empty, for: path, item: id)
            default: cv.dequeueConfiguredReusableCell(using: row, for: path, item: id)
            }
        }
        dataSource.supplementaryViewProvider = { cv, _, path in cv.dequeueConfiguredReusableSupplementary(using: header, for: path) }
    }

    /// The bar's "Chats" title and the pinned chips follow the scroll.
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let scrolled = max(0, scrollView.contentOffset.y + scrollView.adjustedContentInset.top)
        if abs(todayLayout.scroll - scrolled) > 0.5 { todayLayout.scroll = scrolled }
        let pinned = isPinned(scrollView as! UICollectionView)
        if todayLayout.chipsPinned != pinned { todayLayout.chipsPinned = pinned }
        onScroll?(scrolled)
    }

    /// The pinned header sits below its natural place (just above the first chat) once the list has scrolled under it.
    private func isPinned(_ cv: UICollectionView) -> Bool {
        guard showsHeader, cv.numberOfSections > 0, cv.numberOfItems(inSection: 0) > 0,
              let header = cv.layoutAttributesForSupplementaryElement(ofKind: UICollectionView.elementKindSectionHeader, at: IndexPath(item: 0, section: 0)),
              let first = cv.layoutAttributesForItem(at: IndexPath(item: 0, section: 0)) else { return false }
        return header.frame.minY > first.frame.minY - header.frame.height + 0.5
    }

    /// The first population lands at once and unanimated; later changes are coalesced for ~100 ms (the optimistic
    /// local flag and the server echo arrive together) and applied once, animated.
    func update(rows: [Conversation], filter: ChatFilter, platforms: [ChannelPlatform], selected: String?, query: String) {
        self.selected = selected
        filterState.platforms = platforms
        let first = !loaded
        if first, rows.isEmpty, world.conversations.isEmpty, world.todayRemote == nil { return }
        pending?.cancel()
        if first {
            loaded = true
            apply(rows, filter: filter, query: query, animated: false)
        } else {
            pending = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { return }
                self?.apply(rows, filter: filter, query: query, animated: true)
            }
        }
    }

    private func apply(_ rows: [Conversation], filter: ChatFilter, query: String, animated: Bool) {
        var seen = Set<String>()
        let rows = rows.filter { seen.insert($0.id).inserted }
        let changed = rows.filter { byId[$0.id] != nil && byId[$0.id] != $0 }.map(\.id)
        self.rows = rows
        byId = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        emptyText = query.isEmpty ? "Nothing here" : "No results"
        let emptyChanged = rows.isEmpty && (self.filter != filter || self.query != query)
        self.filter = filter; self.query = query
        filterState.filter = filter

        var snap = NSDiffableDataSourceSnapshot<Section, String>()
        // The Chat tab is the plain chat list (owner-approved 2026-10-26): Today and its For-you cards live on the Today tab.
        snap.appendSections([.chats])
        // A new user has no chats yet: the Today tab (welcome, first agent) is their home, so this list shows no header.
        let welcome = rows.isEmpty && query.isEmpty && filter == .all && world.today.userState == .new
        // One chat so far: a faint way on to the next agent under it.
        let another = rows.count == 1 && query.isEmpty && filter == .all
        snap.appendItems(welcome ? [] : rows.isEmpty ? [Self.emptyId] : rows.map(\.id) + (another ? [Self.anotherId] : []), toSection: .chats)
        if showsHeader == welcome {
            showsHeader = !welcome
            collectionView?.collectionViewLayout.invalidateLayout()
        }
        // A row whose content changed is reconfigured in place, never replaced. Only rows still in the new snapshot can be
        // reconfigured: a filter tab drops the empty row, and reconfiguring a missing id throws (crash on switching to Groups, 2026-10-21).
        let present = Set(snap.itemIdentifiers)
        snap.reconfigureItems(((emptyChanged ? [Self.emptyId] : []) + changed).filter(present.contains))
        let current = dataSource.snapshot()
        let oldOrder = current.sectionIdentifiers.contains(.chats) ? current.itemIdentifiers(inSection: .chats).filter { $0 != Self.anotherId } : []
        let newOrder = snap.itemIdentifiers(inSection: .chats).filter { $0 != Self.anotherId }
        if animated, oldOrder != newOrder, Set(oldOrder) == Set(newOrder) {
            slideReorder(snap, oldOrder: oldOrder, newOrder: newOrder)
        } else {
            dataSource.apply(snap, animatingDifferences: animated) { [weak self] in self?.syncSelection() }
        }
    }

    /// UIKit's own move animation sends the row up over the header (and hides it behind its neighbours). Reordering
    /// is applied at once, then every row slides from where it was to where it is, the moved rows above the rest.
    private func slideReorder(_ snap: NSDiffableDataSourceSnapshot<Section, String>, oldOrder: [String], newOrder: [String]) {
        guard let cv = collectionView else { return }
        var from: [String: CGFloat] = [:]
        for (i, id) in oldOrder.enumerated() {
            if let f = cv.layoutAttributesForItem(at: IndexPath(item: i, section: 0))?.frame { from[id] = f.minY }
        }
        let moved = Set(newOrder.difference(from: oldOrder).compactMap { change -> String? in
            if case .insert(_, let id, let associated) = change, associated != nil { id } else { nil }
        })
        UIView.performWithoutAnimation {
            dataSource.apply(snap, animatingDifferences: false)
            cv.layoutIfNeeded()
            syncSelection()
        }
        for case let cell as UICollectionViewListCell in cv.visibleCells {
            guard let path = cv.indexPath(for: cell), let id = dataSource.itemIdentifier(for: path), let y = from[id] else { continue }
            let dy = y - cell.frame.minY
            guard abs(dy) > 0.5 else { continue }
            // A layer animation: the collection view resets a view's transform whenever it lays the cell out.
            let slide = CASpringAnimation(keyPath: "position.y")
            slide.fromValue = cell.layer.position.y + dy
            slide.toValue = cell.layer.position.y
            slide.mass = 1; slide.stiffness = 260; slide.damping = 28
            slide.duration = slide.settlingDuration
            cell.layer.zPosition = moved.contains(id) ? 1 : 0
            cell.layer.add(slide, forKey: "slide")
            if moved.contains(id) {
                // Opaque while it crosses the other rows, so their text doesn't show through.
                cell.backgroundColor = UIColor(Theme.canvas)
                DispatchQueue.main.asyncAfter(deadline: .now() + slide.duration) {
                    cell.layer.zPosition = 0
                    cell.backgroundColor = nil
                }
            }
        }
    }

    private func syncSelection() {
        guard let cv = collectionView else { return }
        if let selected, let path = dataSource.indexPath(for: selected) {
            if cv.indexPathsForSelectedItems?.first != path { cv.selectItem(at: path, animated: false, scrollPosition: []) }
        } else {
            cv.indexPathsForSelectedItems?.forEach { cv.deselectItem(at: $0, animated: false) }
        }
    }

    // MARK: Selection

    func collectionView(_ cv: UICollectionView, shouldSelectItemAt path: IndexPath) -> Bool {
        guard let id = dataSource.itemIdentifier(for: path) else { return false }
        return !id.hasPrefix("~")
    }

    func collectionView(_ cv: UICollectionView, didSelectItemAt path: IndexPath) {
        if let id = dataSource.itemIdentifier(for: path) { onOpen(id) }
    }

    func collectionView(_ cv: UICollectionView, contextMenuConfigurationForItemAt path: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        guard let id = dataSource.itemIdentifier(for: path), let c = byId[id], c.kind != "room", let a = c.agentIds?.first else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
            UIMenu(children: [UIAction(title: "Profile", image: UIImage(systemName: "person.crop.circle")) { [weak self] _ in
                self?.world.openAgentPage(a, from: "list-\(a)")
            }])
        }
    }

    // MARK: Swipe actions

    private func conversation(at path: IndexPath) -> Conversation? {
        dataSource.itemIdentifier(for: path).flatMap { byId[$0] }
    }

    private func action(_ title: String, _ icon: String, _ tint: Color, _ run: @escaping @MainActor () -> Void) -> UIContextualAction {
        let a = UIContextualAction(style: .normal, title: title) { _, _, done in
            done(true)
            // The row is still closing its swipe; a data change now would pin it in place while the others move.
            Task { try? await Task.sleep(for: .milliseconds(350)); run() }
        }
        a.image = UIImage(systemName: icon)
        a.backgroundColor = UIColor(tint)
        return a
    }

    private func leadingActions(_ path: IndexPath) -> UISwipeActionsConfiguration? {
        guard let c = conversation(at: path) else { return nil }
        let pinned = c.pinned ?? false
        var actions = [action(pinned ? "Unpin" : "Pin", pinned ? "pin.slash" : "pin", Theme.fgMuted) { [weak self] in
            self?.world.setConversationFlag(c.id, pinned: !pinned)
        }]
        if (c.unreadCount ?? 0) > 0 {
            actions.append(action("Read", "checkmark.message", Theme.primary) { [weak self] in self?.world.markConversationRead(c.id) })
        }
        let config = UISwipeActionsConfiguration(actions: actions)
        config.performsFirstActionWithFullSwipe = true
        return config
    }

    private func trailingActions(_ path: IndexPath) -> UISwipeActionsConfiguration? {
        guard let c = conversation(at: path) else { return nil }
        let muted = c.muted ?? false
        let config = UISwipeActionsConfiguration(actions: [
            action("Delete", "trash", Theme.danger) { [weak self] in self?.onDelete(c) },
            action(muted ? "Unmute" : "Mute", muted ? "bell" : "bell.slash", Theme.fgSubtle) { [weak self] in
                self?.world.setConversationFlag(c.id, muted: !muted)
            },
        ])
        config.performsFirstActionWithFullSwipe = false
        return config
    }
}

private enum NewChatRoute: Hashable { case members, review, newAgent }

/// Shared by the Chats list and sidebar. The sheet owns its navigation and draft state so a failed create
/// remains editable and retryable without closing the sheet.
struct NewChatSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    @State private var path: [NewChatRoute] = []
    @State private var query = ""
    @State private var selectedIDs: Set<String> = []
    @State private var groupName = ""
    @State private var requestId = UUID().uuidString
    @State private var isBusy = false
    @State private var error: String?
    @State private var pendingDirect: (agentId: String, requestId: String)?

    var startsWithNewAgent = false
    var onOpenChat: (String) -> Void

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if world.agents.isEmpty {
                    NewChatEmpty(busy: isBusy) { path.append(.newAgent) }
                } else {
                    agentList
                        .searchable(text: $query, prompt: "Search agents")
                        .accessibilityIdentifier("new-chat-searchable")
                }
            }
            .pageHeader("New chat")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isBusy)
                }
            }
            .navigationDestination(for: NewChatRoute.self) { route in
                switch route {
                case .members:
                    NewGroupMembers(selectedIDs: $selectedIDs) { path.append(.review) }
                case .review:
                    NewGroupReview(selectedIDs: $selectedIDs, groupName: $groupName, requestId: $requestId,
                                   isBusy: $isBusy, error: $error, onCreated: onOpenChat)
                case .newAgent:
                    NewAgentSheet(embedded: true, onCreated: onOpenChat)
                }
            }
        }
        .tint(Theme.fg)
        .presentationDetents([.large])
        .interactiveDismissDisabled(isBusy)
        .onChange(of: path) { _, _ in error = nil }
        .onChange(of: selectedIDs) { _, _ in requestId = UUID().uuidString; error = nil }
        .onChange(of: groupName) { _, _ in requestId = UUID().uuidString; error = nil }
        .onAppear {
            if startsWithNewAgent, path.isEmpty { path = [.newAgent] }
        }
    }

    private var agentList: some View {
        List {
            Section {
                NavigationLink(value: NewChatRoute.members) {
                    Label("New group", systemImage: "person.2")
                }
                .disabled(isBusy)
                .accessibilityIdentifier("new-chat-new-group")
                NavigationLink(value: NewChatRoute.newAgent) {
                    Label("New agent", systemImage: "person.crop.circle.badge.plus")
                }
                .disabled(isBusy)
                .accessibilityIdentifier("new-chat-new-agent")
            }
            if let error {
                Section("Couldn't create chat") {
                    Text(error).foregroundStyle(Theme.danger)
                    if let pendingDirect {
                        Button("Retry") { createDirect(pendingDirect.agentId, requestId: pendingDirect.requestId) }
                            .accessibilityIdentifier("new-chat-direct-retry")
                    }
                }
            }
            Section("Agents") {
                if matchingAgents.isEmpty {
                    ContentUnavailableView("No matching agents", systemImage: "person.crop.circle")
                } else {
                    ForEach(matchingAgents) { agent in
                        Button { beginDirect(with: agent) } label: {
                            HStack {
                                AgentIdentityLabel(agent: agent)
                                Spacer()
                                if isBusy, pendingDirect?.agentId == agent.id { ProgressView() }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isBusy)
                        .accessibilityIdentifier("new-chat-agent-\(agent.id)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
    }

    private var matchingAgents: [Agent] {
        world.agents.filter { query.isEmpty || ($0.name ?? "").localizedCaseInsensitiveContains(query)
            || ($0.title ?? "").localizedCaseInsensitiveContains(query) }
    }

    private func beginDirect(with agent: Agent) {
        if let chat = world.directConversation(for: agent.id) { onOpenChat(chat.id); return }
        let id = UUID().uuidString
        pendingDirect = (agent.id, id)
        createDirect(agent.id, requestId: id)
    }

    private func createDirect(_ agentId: String, requestId: String) {
        guard let agent = world.agent(agentId) else { return }
        isBusy = true
        error = nil
        Task { @MainActor in
            do {
                let conversation = try await world.createConversation(kind: "direct", memberAgentIds: [agent.id], title: nil, requestId: requestId)
                isBusy = false
                onOpenChat(conversation.id)
            } catch {
                isBusy = false
                self.error = error.localizedDescription
            }
        }
    }
}

/// No agents yet: one illustration, one line, one way forward.
private struct NewChatEmpty: View {
    var busy: Bool
    var onCreate: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            AvatarView(agent: Agent(id: "new-chat-empty", avatar: Avatar(character: "mint")), size: 112)
                .frame(width: 128, height: 128)
                .accessibilityHidden(true)
            VStack(spacing: 6) {
                Text("No agents yet").text(.xl, .semibold).foregroundStyle(Theme.fg)
                Text("Create an agent to start a chat. It can also take on work for you.")
                    .text(.base).foregroundStyle(Theme.fgMuted).multilineTextAlignment(.center)
            }
            Button("Create your first agent", action: onCreate)
                .buttonStyle(WebButton(variant: .primary, size: .hero))
                .disabled(busy)
                .accessibilityIdentifier("new-chat-create-first-agent")
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.canvas)
    }
}

private struct NewGroupMembers: View {
    @Environment(World.self) private var world
    @Binding var selectedIDs: Set<String>
    @State private var query = ""
    var onNext: () -> Void

    var body: some View {
        List {
            if !selectedAgents.isEmpty {
                Section("Selected · \(selectedAgents.count)/6") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(selectedAgents) { agent in
                                Button { toggle(agent) } label: {
                                    VStack(spacing: 4) {
                                        AvatarView(agent: agent, size: 38)
                                        Text(agent.name ?? "Agent").font(.caption).foregroundStyle(Theme.fg).lineLimit(1).frame(width: 62)
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove \(agent.name ?? "agent")")
                            }
                        }
                    }
                    .accessibilityIdentifier("new-group-selected-members")
                }
            }
            Section("Choose 2–6 agents") {
                if matchingAgents.isEmpty {
                    ContentUnavailableView(query.isEmpty ? "No agents yet" : "No matching agents",
                                           systemImage: "person.crop.circle")
                } else {
                    ForEach(matchingAgents) { agent in
                        Button { toggle(agent) } label: {
                            HStack {
                                AgentIdentityLabel(agent: agent)
                                Spacer()
                                Image(systemName: selectedIDs.contains(agent.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selectedIDs.contains(agent.id) ? Theme.fg : Theme.fgSubtle)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(!selectedIDs.contains(agent.id) && selectedIDs.count >= 6)
                        .accessibilityIdentifier("new-group-member-\(agent.id)")
                        .accessibilityAddTraits(selectedIDs.contains(agent.id) ? .isSelected : [])
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .searchable(text: $query, prompt: "Search agents")
        .accessibilityIdentifier("new-group-member-searchable")
        .pageHeader("New group")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Next") {
                    onNext()
                }
                    .disabled(selectedIDs.count < 2 || selectedIDs.count > 6)
                    .accessibilityIdentifier("new-group-next")
            }
        }
    }

    private var selectedAgents: [Agent] { world.agents.filter { selectedIDs.contains($0.id) } }
    private var matchingAgents: [Agent] {
        world.agents.filter { query.isEmpty || ($0.name ?? "").localizedCaseInsensitiveContains(query)
            || ($0.title ?? "").localizedCaseInsensitiveContains(query) }
    }
    private func toggle(_ agent: Agent) {
        if selectedIDs.contains(agent.id) { selectedIDs.remove(agent.id) }
        else if selectedIDs.count < 6 { selectedIDs.insert(agent.id) }
    }
}

private struct AgentIdentityLabel: View {
    var agent: Agent
    var body: some View {
        HStack(spacing: 12) {
            AvatarView(agent: agent, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name ?? "Agent").foregroundStyle(Theme.fg)
                if let title = agent.title, !title.isEmpty {
                    Text(title).font(.subheadline).foregroundStyle(Theme.fgSubtle).lineLimit(1)
                }
            }
        }
        .contentShape(Rectangle())
    }
}

private struct NewGroupReview: View {
    @Environment(World.self) private var world
    @Binding var selectedIDs: Set<String>
    @Binding var groupName: String
    @Binding var requestId: String
    @Binding var isBusy: Bool
    @Binding var error: String?
    var onCreated: (String) -> Void

    private var members: [Agent] { world.agents.filter { selectedIDs.contains($0.id) } }
    private var resolvedTitle: String {
        let edited = groupName.trimmingCharacters(in: .whitespacesAndNewlines)
        return edited.isEmpty ? members.compactMap(\.name).joined(separator: ", ") : edited
    }

    var body: some View {
        Form {
            Section("Group name") {
                TextField(members.compactMap(\.name).joined(separator: ", "), text: $groupName)
                    .textInputAutocapitalization(.words)
                    .disabled(isBusy)
            }
            Section("Members · \(members.count)") {
                ForEach(members) { agent in
                    HStack(spacing: 10) {
                        AvatarView(agent: agent, size: 34)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(agent.name ?? "Agent").foregroundStyle(Theme.fg)
                            if let title = agent.title, !title.isEmpty {
                                Text(title).font(.caption).foregroundStyle(Theme.fgSubtle)
                            }
                        }
                    }
                    .accessibilityIdentifier("new-group-review-member-\(agent.id)")
                }
            }
            Section {
                Label("Mention an agent to get a reply", systemImage: "at")
                    .foregroundStyle(Theme.fgMuted)
            }
            if let error {
                Section("Couldn't create group") { Text(error).foregroundStyle(Theme.danger) }
            }
            Section {
                Button(action: create) {
                    HStack {
                        Spacer()
                        if isBusy { ProgressView().tint(Theme.primaryFg) }
                        else { Text("Create group") }
                        Spacer()
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.primary)
                .disabled(isBusy || members.count < 2 || members.count > 6)
                .accessibilityIdentifier("new-group-create")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .pageHeader("Confirm group")
        .navigationBarBackButtonHidden(isBusy)
        .interactiveDismissDisabled(isBusy)
    }

    private func create() {
        guard (2...6).contains(members.count) else { return }
        isBusy = true
        error = nil
        let ids = members.map(\.id)
        let title = resolvedTitle
        let currentRequestId = requestId
        Task { @MainActor in
            do {
                let conversation = try await world.createConversation(kind: "room", memberAgentIds: ids,
                                                                      title: title, requestId: currentRequestId)
                isBusy = false
                onCreated(conversation.id)
            } catch {
                isBusy = false
                self.error = error.localizedDescription
            }
        }
    }
}

struct ConversationRow: View {
    @Environment(World.self) private var world
    var conversation: Conversation

    var body: some View {
        let agents = (conversation.agentIds ?? []).compactMap(world.agent)
        let unread = conversation.unreadCount ?? 0
        let muted = conversation.muted ?? false
        let workingRun = world.activeRuns(in: conversation.id).first {
            $0.parentRunId == nil && ["running", "queued"].contains($0.status ?? "")
        }
        HStack(spacing: 12) {
            avatar(agents, working: workingRun != nil)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(Self.title(conversation, world)).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.fg).lineLimit(1)
                    if let platform = ChannelPlatform(kind: conversation.channel?.kind) {
                        ChannelBadge(platform: platform, size: 15).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                    }
                    if muted { Image(systemName: "bell.slash.fill").font(.system(size: 11)).foregroundStyle(Theme.fgSubtle) }
                    Spacer(minLength: 4)
                    Text(Fmt.time(conversation.lastItemAt)).text(.sm).foregroundStyle(unread > 0 ? Theme.fg : Theme.fgSubtle)
                }
                HStack(alignment: .top, spacing: 8) {
                    subtitle(working: workingRun).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    if conversation.pinned ?? false {
                        Image(systemName: "pin.fill").font(.system(size: 12)).foregroundStyle(Theme.fgSubtle)
                    }
                    if unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.primaryFg)
                            .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
                            .background(muted ? Theme.fgSubtle : Theme.primary, in: .capsule)
                    }
                }
            }
        }
        .frame(minHeight: 76)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func avatar(_ agents: [Agent], working: Bool) -> some View {
        Group {
            if conversation.kind == "room" { GroupAvatar(agents: agents, size: 52) }
            else { AvatarView(agent: agents.first, size: 52).agentZoomSource("list-\(agents.first?.id ?? "")") }
        }
        .overlay(alignment: .bottomTrailing) {
            if working {
                Circle().fill(Theme.success).frame(width: 12, height: 12)
                    .overlay(Circle().stroke(Theme.canvas, lineWidth: 2)).offset(x: 1, y: 1)
            }
        }
    }

    @ViewBuilder private func subtitle(working: Run?) -> some View {
        if let working {
            Text("● Working" + (working.title.map { " · \($0)" } ?? "")).text(.base).foregroundStyle(StatusTone("working").color)
        } else if let ask = world.needsYou(in: conversation.id).first {
            Text("Needs you: \(ask.sentence)").text(.base).foregroundStyle(Theme.warning)
        } else if let preview = conversation.lastMessagePreview {
            Text(preview).text(.base).foregroundStyle(Theme.fgSubtle)
        }
    }

    static func title(_ c: Conversation, _ world: World) -> String {
        if let t = c.title, !t.isEmpty { return t }
        let names = (c.agentIds ?? []).compactMap { world.agent($0)?.name }.joined(separator: ", ")
        return names.isEmpty ? "Untitled chat" : names
    }
}

