import SwiftUI
import UIKit

// MARK: - Artifact picture, cell and chat card (one look for the Library, the chat and the Files tab)
// The picture comes from the latest version's first-page thumbnail, else the image itself (cut down before it is kept),
// else the render type's symbol on the neutral muted surface. Tapping any of them opens `ArtifactViewer`.

extension LibraryItem {
    /// The newest version's number: the version the picture and a download show.
    var latestVersionNumber: Int? { versions?.first { $0.version == version }?.version ?? versions?.last?.version ?? version }

    var latestVersion: Contract.ArtifactVersion? { versions?.first { $0.version == version } ?? versions?.last }

    /// A running app (its chat card or a Space).
    var isSpace: Bool { render == "app" || spaceId != nil }

    var isImage: Bool { render == "image" || kind == "image" || (mimeType ?? "").hasPrefix("image/") }

    var isVideo: Bool { render == "video" || (mimeType ?? "").hasPrefix("video/") }
}

/// Which picture an item shows: the latest version's thumbnail, the image itself, or nothing (the symbol).
enum ArtifactPicture {
    case thumbnail(version: Int)
    case image(version: Int?)
    case none
}

extension LibraryItem {
    var picture: ArtifactPicture {
        if let v = latestVersion, v.thumbnailRef != nil, let n = v.version { return .thumbnail(version: n) }
        if isImage { return .image(version: latestVersionNumber) }
        return .none
    }
}

/// The muted status word of a Space, as the web shows it: Running / Paused (other states name themselves).
func spaceStatusWord(_ status: String?) -> String? {
    switch status {
    case "running": "Running"
    case "computer_paused": "Paused"
    case "not_listening": "Not listening"
    default: nil
    }
}

extension World {
    /// The bytes of an item's version: a published version's part, or the library download of a plain file.
    func itemBytes(_ file: LibraryItem, version: Int?, part: String = "file") async throws -> Data {
        if file.render != nil, let version { return try await artifactBytes(file.id, version: version, part: part).data }
        guard let api else { throw APIError.badServer }
        return try Data(contentsOf: try await api.downloadFile(file.id))
    }
}

/// The picture of one item, filled to its frame. It loads when it is shown (a lazy grid only shows what is on screen).
struct ArtifactThumbnail: View {
    @Environment(World.self) private var world
    var file: LibraryItem
    /// The size of the symbol shown while there is no picture (a grid cell uses xxl, a list row xxs-lg).
    var symbol: TextSize = .xxl
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Theme.muted
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: icon(file)).text(symbol).foregroundStyle(Theme.fgSubtle)
            }
        }
        .clipped()
        .task(id: "\(file.id)-\(file.latestVersionNumber ?? 0)") { await load() }
    }

    private func load() async {
        let data: Data?
        switch file.picture {
        case .thumbnail(let v): data = try? await world.artifactBytes(file.id, version: v, part: "thumbnail").data
        case .image(let v): data = try? await world.itemBytes(file, version: v)
        case .none: return
        }
        guard let data, let full = UIImage(data: data) else { return }
        // A grid cell needs a few hundred points at most: keep the small picture, not the original.
        image = await full.byPreparingThumbnail(ofSize: CGSize(width: 480, height: 480)) ?? full
    }
}

/// One item as a cell: its picture (4:3, a small corner radius), the name on one line and a muted line
/// "<agent> · <status> · <time>" (a Space shows its status word; a Shared item has no extra word).
struct ArtifactCell: View {
    @Environment(World.self) private var world
    var file: LibraryItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ArtifactThumbnail(file: file)
                .frame(maxWidth: .infinity)
                .aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(.rect(cornerRadius: Radius.md))
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name ?? "").text(.base, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                Text(meta).text(.xs).foregroundStyle(Theme.fgSubtle).lineLimit(1)
            }
            .padding(.horizontal, 2)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("library-\(file.id)")
        .task(id: file.id) { if file.render == "doc" { try? await world.loadDocument(file.id) } }
    }

    private var meta: String {
        // A document an agent proposed and nobody has decided yet says so under its name.
        if file.render == "doc", world.documents[file.id]?.openDraft?.author?.agentId != nil { return "Draft · waiting for your review" }
        let author = world.agent(file.createdByAgentId)?.name ?? (file.source == "upload" ? "You" : nil)
        let status = file.isSpace ? spaceStatusWord(world.spaces.first { $0.id == file.spaceId }?.status) : nil
        return [author, status, Fmt.ago(file.createdAt)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// A produced file in the chat: its cell, 260 pt wide. Tapping it opens the full-screen viewer.
struct ArtifactCard: View {
    var file: LibraryItem
    @State private var viewing = false

    var body: some View {
        ArtifactCell(file: file)
            .frame(width: 260, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .tapOnly { viewing = true }
            .fullScreenCover(isPresented: $viewing) { ArtifactViewer(file: file) }
    }
}
