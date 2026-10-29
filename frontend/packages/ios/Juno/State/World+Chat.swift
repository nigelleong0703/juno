import Foundation
import SwiftUI
import UIKit

extension World {
    func react(_ itemId: String, _ emoji: String?) {
        reactions[itemId] = emoji
        UserDefaults.standard.set(reactions, forKey: "reactions")
    }

    /// Send again a message that failed: same text, a fresh attempt at the end of the chat.
    func retry(_ itemId: String, in conversationId: String) {
        guard let old = items[conversationId]?.first(where: { $0.id == itemId }), old.text != nil else { return }
        // Retry the same stable id: if the first 202 was lost, the server's item.added can still settle this row.
        outbox[itemId] = nil
        // The failed bubble moves to the queue's newest position, while its wire identity stays unchanged.
        items[conversationId]?.removeAll { $0.id == itemId }
        items[conversationId]?.append(old)
        submit(old, in: conversationId)
    }

    func discard(_ itemId: String, in conversationId: String) {
        items[conversationId]?.removeAll { $0.id == itemId }
        outbox[itemId] = nil
    }

    /// POST /v1/transcriptions: the recording (AAC m4a) in, the spoken text out. Nothing is kept server-side.
    func transcribe(_ audio: Data) async throws -> String {
        guard let api else { throw APIError.http(401, "Sign in to dictate.") }
        struct Result: Decodable { var text: String }
        let raw = try await api.postRaw("/v1/transcriptions", audio, contentType: "audio/mp4")
        return try JSONDecoder().decode(Result.self, from: raw).text
    }

    /// POST /v1/uploads: the file goes up first; the returned attachment is what a message carries.
    func upload(_ data: Data, name: String, mimeType: String) async throws -> Attachment {
        let kind = mimeType.hasPrefix("image/") ? "image" : "file"
        guard let api else { throw APIError.http(401, "Sign in to attach files.") }
        struct Body: Encodable { var name: String; var mimeType: String; var contentBase64: String }
        let raw = try await api.post("/v1/uploads", Body(name: name, mimeType: mimeType, contentBase64: data.base64EncodedString()))
        struct Envelope: Decodable { var attachment: Attachment }
        if let a = try? isoDecoder.decode(Attachment.self, from: raw) { return a }
        return try isoDecoder.decode(Envelope.self, from: raw).attachment
    }

    /// POST /v1/conversations/:id/typing: best-effort presence, so a failure is dropped and never shown.
    func reportTyping(_ active: Bool, in conversationId: String) {
        guard let api else { return }
        struct Body: Encodable { var active: Bool }
        Task { _ = try? await api.post("/v1/conversations/\(conversationId)/typing", Body(active: active)) }
    }

    /// Reply buttons show on the latest agent turn only: once any user message follows the bubble they go.
    func repliesOpen(_ item: Item) -> Bool {
        guard let list = items[item.conversationId ?? ""], let i = list.firstIndex(where: { $0.id == item.id }) else { return false }
        return !list[(i + 1)...].contains { $0.type == "user_message" }
    }

    func send(_ text: String, in conversationId: String, files: [Attachment] = [], mentions: [Mention] = []) {
        let id = UUID().uuidString
        var item = Item(id: id, conversationId: conversationId, at: Date(), type: "user_message", authorId: selfId, text: text)
        if !files.isEmpty { item.attachments = files }
        if !mentions.isEmpty { item.mentions = mentions }
        items[conversationId, default: []].append(item)
        if let index = conversations.firstIndex(where: { $0.id == conversationId }) {
            conversations[index].lastItemAt = Date()
            conversations[index].lastMessagePreview = text
        }
        submit(item, in: conversationId)
    }

    /// POST /v1/conversations/:id/runs with RunAgentInput. The whole composer rides in
    /// forwardedProps.juno.composer; the standard user message still carries text (and upload URLs) so the
    /// current AG-UI ingress can admit it.
    private func submit(_ item: Item, in conversationId: String) {
        guard let api else { return }
        askForNotificationsIfLong(in: conversationId)
        // Not the shared `remote` (an alert): a failed send stays on the message itself, with Retry.
        let id = item.id
        outbox[id] = .some(nil)
        Task { @MainActor in
            do {
                let input = Self.runInput(for: item, conversationId: conversationId, authorId: selfId)
                let data = try await api.post("/v1/conversations/\(conversationId)/runs", input)
                guard self.api?.session == api.session else { return }
                self.outbox[id] = nil
                struct Accepted: Decodable { var item: Item?; var runId: String? }
                if let sent = (try? isoDecoder.decode(Accepted.self, from: data))?.item,
                   let i = self.items[conversationId]?.firstIndex(where: { $0.id == id }) {
                    self.store?.upsertLive(conversationId, [sent])
                    self.displayIds[sent.id] = id
                    if sent.id != id, self.items[conversationId]?.contains(where: { $0.id == sent.id }) == true {
                        self.items[conversationId]?.remove(at: i)
                    }
                    else {
                        self.items[conversationId]?[i] = sent
                    }
                }
            } catch {
                if self.api?.session == api.session { self.outbox[id] = .some(error.localizedDescription) }
            }
        }
    }

    private static func runInput(for item: Item, conversationId: String, authorId: String) -> Contract.RunAgentInput {
        let text = item.text ?? ""
        let files = item.attachments ?? []
        let mentions = item.mentions ?? []
        let composer = ComposerPayload(text: text, attachments: files.isEmpty ? nil : files, mentions: mentions.isEmpty ? nil : mentions)
        let content: JSONValue = .array([.object(["type": .string("text"), "text": .string(text)])] + files.compactMap { file in
            var part: [String: JSONValue] = ["type": .string(file.kind ?? "file"), "id": .string(file.id)]
            // Uploaded attachments usually expose only their owner-library id. The complete object is in
            // forwardedProps.juno.composer; a URL part is valid only when that public source exists.
            guard let url = file.url, !url.isEmpty else { return nil }
            var source: [String: JSONValue] = ["type": .string("url"), "value": .string(url)]
            if let mime = file.mimeType { source["mimeType"] = .string(mime) }
            part["source"] = .object(source)
            return .object(part)
        })
        let message = Contract.RunAgentInput.Message(
            id: item.id, role: "user",
            metadata: .object(["juno": .object(["authorId": .string(authorId), "conversationId": .string(conversationId)])]),
            content: content)
        return Contract.RunAgentInput(
            threadId: conversationId, runId: UUID().uuidString, messages: [message],
            forwardedProps: .object(["juno": .object(["composer": encodedJSONValue(composer)])]))
    }

    private struct ComposerPayload: Encodable {
        var text: String
        var attachments: [Attachment]?
        var mentions: [Mention]?
    }

    /// The notification prompt waits for the first moment it helps: a reply that is still being worked on ~10s after
    /// the user sent, or something they set up to notify later. Never in the first conversation's first 3 messages.
    func askForNotifications() {
        let first = conversations.count <= 1
        let sent = items.values.joined().filter { $0.type == "user_message" }.count
        if first && sent <= 3 { return }
        PushRegistrar.shared.askForPermission()
    }

    private func askForNotificationsIfLong(in conversationId: String) {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(10))
            if !activeRuns(in: conversationId).filter({ $0.parentRunId == nil }).isEmpty { askForNotifications() }
        }
    }

    /// Chat-list swipe actions: pin / mute (PATCH), mark read, delete (DELETE). Local first, the server follows.
    func setConversationFlag(_ id: String, pinned: Bool? = nil, muted: Bool? = nil) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        if let pinned { conversations[i].pinned = pinned }
        if let muted { conversations[i].muted = muted }
        struct Patch: Encodable { var pinned: Bool?; var muted: Bool? }
        remote { try await $0.patch("/v1/conversations/\(id)", Patch(pinned: pinned, muted: muted)) }
    }

    func markConversationRead(_ id: String) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[i].unreadCount = 0
        remote { _ = try await $0.post("/v1/conversations/\(id)/mark-read") }
    }

    /// An item arriving in the open chat is read as it arrives: one mark-read after a second of quiet, so a
    /// streamed reply posts once rather than per item.
    func scheduleMarkRead(_ id: String) {
        markReadTask?.cancel()
        markReadTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            markConversationRead(id)
        }
    }

    func deleteConversation(_ id: String) {
        conversations.removeAll { $0.id == id }
        if currentConversationId == id { currentConversationId = nil }
        remote { try await $0.delete("/v1/conversations/\(id)") }
    }
}
