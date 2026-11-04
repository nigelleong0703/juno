import Foundation

/// The body of `POST /v1/conversations/:id/runs` for one message the person sent: the whole composer rides in
/// `forwardedProps.juno.composer`; the standard user message still carries text (and upload URLs) so the current AG-UI ingress can
/// admit it. The chat composer and the Siri / Shortcuts intents send the same thing.
enum UserMessageRun {
    static func input(for item: Item, conversationId: String, authorId: String) -> Contract.RunAgentInput {
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
}
