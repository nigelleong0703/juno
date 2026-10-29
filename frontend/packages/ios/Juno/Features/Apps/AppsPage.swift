import SwiftUI

/// Apps (account menu; replaces Plugins › Connectors), modelled on ChatGPT's app directory and owner-approved 2026-10-26: a large
/// title, a search field, swipeable featured banners, the pills Connected · Chat · Work · Web & video, then plain rows (the app's
/// icon, name, one line, "Sign in" in the warning colour when an account expired, a chevron). Web & video apps are listed with
/// "Coming soon". A search looks across every category. Native list; the title, search and pills are its first rows.
struct AppsPage: View {
    @Environment(World.self) private var world
    @State private var query = ""
    @State private var picked: AppFilter?
    @State private var limit = Self.pageSize
    @State private var installer = AppInstaller()

    private static let pageSize = 12

    var body: some View {
        let apps = world.apps ?? []
        let filter = picked ?? AppFilter.initial(for: apps)
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let rows = AppFilter.visible(apps, filter: filter, query: query)
        let featured = AppFilter.featured(apps)
        List {
            TabHeading(title: "Apps").teamRow(separator: false)
            TeamSearchField(text: $query, prompt: "Search apps").teamRow(separator: false)
            if !searching && !featured.isEmpty {
                FeaturedApps(apps: featured).teamRow(separator: false, vertical: 8).listRowInsets(EdgeInsets())
            }
            if !searching {
                Picker("Apps", selection: Binding(get: { filter }, set: { picked = $0; limit = Self.pageSize })) {
                    ForEach(AppFilter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("apps-filter")
                .teamRow(separator: false, vertical: 8)
            }
            if world.apps == nil {
                if world.appsLoadFailed {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Couldn't load your apps.").text(.base).foregroundStyle(Theme.fgMuted)
                        Button("Try again") { Task { await world.refreshApps() } }.buttonStyle(WebButton(variant: .secondary, size: .regular))
                    }
                    .teamRow(separator: false)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 24).teamRow(separator: false)
                }
            } else {
                if rows.isEmpty {
                    EmptyLine(text: emptyText(filter: filter, searching: searching)).teamRow(separator: false)
                }
                ForEach(rows.prefix(limit)) { app in
                    RouteLink(route: .app(app.id)) { AppRow(app: app) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("app-\(app.id)")
                        .teamRow(separator: false, vertical: 6)
                }
                ShowMore(shown: min(limit, rows.count), total: rows.count) { withAnimation { limit += Self.pageSize } }
                    .teamRow(separator: false)
                if filter == .work && !searching {
                    Button { installer.customForm = true } label: { Label("Add a custom app", systemImage: "plus") }
                        .buttonStyle(WebButton(variant: .secondary, size: .regular))
                        .accessibilityIdentifier("apps-add-custom")
                        .teamRow(separator: false, vertical: 10)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .pageHeader("Apps", revealAfter: 36)
        .appInstaller(installer)
        .onChange(of: query) { limit = Self.pageSize }
        .task { await world.refreshApps() }
        .refreshable { await world.refreshApps() }
    }

    private func emptyText(filter: AppFilter, searching: Bool) -> String {
        if searching { return "No app matches." }
        switch filter {
        case .connected: return "Nothing connected yet. Pick Chat or Work to add an app."
        case .chat: return "No chat apps on this server."
        case .work: return "No work apps on this server."
        case .web: return "Nothing here yet."
        }
    }
}

/// One app: icon, name, one line, its state, a chevron.
struct AppRow: View {
    var app: Contract.App

    var body: some View {
        HStack(spacing: 14) {
            AppIcon(app: app, size: 48)
            VStack(alignment: .leading, spacing: 2) {
                Text(app.displayName).text(.lg, .semibold).foregroundStyle(Theme.fg).lineLimit(1)
                if let blurb = app.blurb, !blurb.isEmpty { Text(blurb).text(.base).foregroundStyle(Theme.fgMuted).lineLimit(1) }
            }
            Spacer(minLength: 8)
            if app.isComingSoon { Text("Coming soon").text(.sm).foregroundStyle(Theme.fgSubtle) }
            else if app.needsSignIn { Text("Sign in").text(.sm).foregroundStyle(Theme.warning) }
            Image(systemName: "chevron.right").text(.xs, .semibold).foregroundStyle(Theme.fgSubtle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// An app's picture: its brand logo from the server (a custom server has none), else a symbol for its kind.
struct AppIcon: View {
    var app: Contract.App
    var size: CGFloat

    var body: some View {
        BrandIcon(catalogId: app.categoryValue == .custom ? nil : app.id, symbol: appSymbol(app.icon), size: size)
    }
}

/// Swipeable banners for the apps that have example prompts: the first one tells what to ask; a tap opens the app.
private struct FeaturedApps: View {
    var apps: [Contract.App]

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(apps) { app in
                    RouteLink(route: .app(app.id)) {
                        SuggestionCard(title: app.displayName, subtitle: app.prompts.first ?? app.blurb ?? "", fillsHeight: true) {
                            AppIcon(app: app, size: 40)
                        }
                    }
                    .buttonStyle(.plain)
                    .frame(width: 280)
                    .accessibilityIdentifier("apps-featured-\(app.id)")
                }
            }
            .scrollTargetLayout()
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 6)
        }
        .scrollTargetBehavior(.viewAligned)
        .contentMargins(.horizontal, 16, for: .scrollContent)
        .scrollIndicators(.hidden)
    }
}

/// The SF Symbol for an app's short icon id, shown while the logo loads or when the server has none.
func appSymbol(_ icon: String?) -> String {
    switch icon {
    case "mail": "envelope"
    case "calendar": "calendar"
    case "folder": "folder"
    case "doc": "doc.text"
    case "table": "tablecells"
    case "notebook": "book"
    case "issues": "circle.dotted"
    case "tasks": "checklist"
    case "jira": "square.grid.2x2"
    case "payments": "creditcard"
    case "automation": "bolt"
    case "fitness": "figure.strengthtraining.traditional"
    case "contacts": "person.crop.circle"
    case "map": "map"
    case "video": "play.rectangle"
    case "music": "music.note"
    case "chat": "bubble.left.and.bubble.right"
    case "web": "globe"
    default: "puzzlepiece.extension"
    }
}
