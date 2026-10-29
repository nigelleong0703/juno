import SwiftUI

// MARK: - Library (owner-approved 2026-10-27): what the agents made for you, as a grid of thumbnails

/// The Library's categories: All · Pages · Files · Spaces · Shared (web: features/library/AgentLibrary.tsx).
enum LibraryFilter: String, CaseIterable, Identifiable {
    case all, pages, files, spaces, shared

    var id: String { rawValue }

    var title: String {
        switch self { case .all: "All"; case .pages: "Pages"; case .files: "Files"; case .spaces: "Spaces"; case .shared: "Shared" }
    }

    /// Pages are interactive pages, Spaces are running apps, Files are everything else an agent made, Shared are the
    /// Spaces with a hosted link.
    func matches(_ item: LibraryItem, hosted: Set<String>) -> Bool {
        switch self {
        case .all: true
        case .pages: item.render == "html"
        case .files: item.render != "html" && !item.isSpace
        case .spaces: item.isSpace
        case .shared: item.spaceId.map(hosted.contains) ?? false
        }
    }
}

struct LibraryPage: View {
    @Environment(World.self) private var world
    @State private var query = ""
    @State private var filter: LibraryFilter = .all
    @State private var opened: LibraryItem?

    /// Agent-made items only (uploads are not here), in the agent scope, matching the search and the category.
    private var items: [LibraryItem] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let hosted = Set(world.spaces.filter { $0.hosted != nil }.map(\.id))
        return world.library
            .filter { $0.source != "upload" }
            .filter { world.scope == nil || $0.createdByAgentId == world.scope }
            .filter { q.isEmpty || ($0.name ?? "").localizedCaseInsensitiveContains(q) }
            .filter { filter.matches($0, hosted: hosted) }
            .sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }

    var body: some View {
        let items = items
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 12) {
                    TabHeading(title: "Library")
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(Theme.fgSubtle)
                        TextField("Search library", text: $query).textFieldStyle(.plain).submitLabel(.search)
                            .autocorrectionDisabled().accessibilityIdentifier("library-search")
                        if !query.isEmpty {
                            Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.fgSubtle) }
                                .buttonStyle(.plain).accessibilityLabel("Clear search")
                        }
                    }
                    .inputField()
                    Picker("Library category", selection: $filter) {
                        ForEach(LibraryFilter.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                if items.isEmpty {
                    ContentUnavailableView(query.isEmpty && filter == .all ? "Nothing here yet" : "No matching items", systemImage: "folder",
                        description: Text(query.isEmpty && filter == .all
                                          ? "Pages, files and apps your agents make for you appear here. They stay private unless you share them."
                                          : "Try another name or category."))
                        .frame(maxWidth: .infinity)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 16)], alignment: .leading, spacing: 24) {
                        ForEach(items) { item in
                            ArtifactCell(file: item).tapOnly { opened = item }
                        }
                    }
                }
            }
            .frame(maxWidth: 640)
            .padding(.horizontal, 16).padding(.top, 0).padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.canvas)
        .tabHeader("Library")
        .task { await world.loadSpaces() }
        .scrollDismissesKeyboard(.interactively)
        .fullScreenCover(item: $opened) { ArtifactViewer(file: $0) }
    }
}
