import Foundation

extension World {
    /// GET / PUT /v1/conversations/:id/group: the owner's settings for the platform group this conversation belongs to.
    func groupSettingsModel(_ conversationId: String) -> GroupSettingsModel? {
        guard let api else { return nil }
        return GroupSettingsModel(
            load: { try await api.get("/v1/conversations/\(conversationId)/group", as: Contract.GroupSettings.self) },
            save: { try isoDecoder.decode(Contract.GroupSettings.self, from: await api.put("/v1/conversations/\(conversationId)/group", $0)) })
    }
}
