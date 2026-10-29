import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// The Rules page's Activity list: the audit log a page at a time (newest first), optionally only the work nobody was there for.
struct ActivityLog {
    var entries: [AuditEntry] = []
    var next: String?
    var unattendedOnly = false
    var loading = false
    var failed = false
    var loaded = false
}

/// The activity CSV as a file the share sheet can take: it is fetched when the user picks a share target.
struct ActivityCSV: Transferable {
    var load: @MainActor @Sendable () async throws -> URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .commaSeparatedText) { item in SentTransferredFile(try await item.load()) }
    }
}

extension World {
    private static let activityPageSize = 20

    /// GET /v1/audit: the first page for the current filter, or the next one after the last shown. A result that arrives after the
    /// filter changed is dropped.
    func loadActivity(more: Bool = false) async {
        guard let api else { return }
        let unattended = activity.unattendedOnly
        let cursor = more ? activity.next : nil
        if more && cursor == nil { return }
        activity.loading = true
        activity.failed = false
        var path = "/v1/audit?limit=\(Self.activityPageSize)" + (unattended ? "&unattended=true" : "")
        if let cursor { path += "&cursor=" + (cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cursor) }
        do {
            let page = try await api.page(path, as: AuditEntry.self)
            guard activity.unattendedOnly == unattended else { return }
            activity.entries = more ? activity.entries + page.items : page.items
            activity.next = page.next
            activity.loaded = true
        } catch {
            guard activity.unattendedOnly == unattended else { return }
            activity.failed = true
        }
        activity.loading = false
    }

    /// "All" or "Unattended": clears the list and loads the first page of the other filter.
    func setActivityUnattended(_ on: Bool) {
        guard activity.unattendedOnly != on else { return }
        activity = ActivityLog(unattendedOnly: on)
        Task { await loadActivity() }
    }

    /// GET /v1/audit/export.csv with the current filter, written to a temporary file for the share sheet.
    func activityCSV() -> ActivityCSV {
        ActivityCSV { [weak self] in
            guard let self, let api = self.api else { throw APIError.badServer }
            let data = try await api.bytes("/v1/audit/export.csv" + (self.activity.unattendedOnly ? "?unattended=true" : ""))
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("juno-activity", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent("juno-activity.csv")
            try data.write(to: url, options: .atomic)
            return url
        }
    }
}
