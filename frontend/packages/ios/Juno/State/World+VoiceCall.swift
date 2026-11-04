import Foundation

extension World {
    /// Opens a room for the current conversation; credentials are short-lived and remain in memory.
    func startVoiceCall(conversationId: String) async throws -> Contract.VoiceCallSession {
        guard let api,
              let encoded = conversationId.addingPercentEncoding(
                  withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))
              ) else { throw APIError.badServer }
        let data = try await api.post("/v1/conversations/\(encoded)/voice-calls")
        return try JSONDecoder().decode(Contract.VoiceCallSession.self, from: data)
    }
}
