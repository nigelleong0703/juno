import Foundation

/// Updates for the same speaker and segment replace each other; final text cannot be
/// overwritten by an out-of-order interim update. An instance belongs to one call.
struct VoiceTranscript {
    private(set) var turns: [VoiceCallView.Turn] = []
    private var index: [String: Int] = [:]

    mutating func update(segmentID: String, participantIdentity: String, localIdentity: String,
                         text: String, isFinal: Bool) {
        guard !segmentID.isEmpty, !participantIdentity.isEmpty, !text.isEmpty else { return }
        let key = "\(participantIdentity.utf8.count):\(participantIdentity)\(segmentID)"
        let turn = VoiceCallView.Turn(id: key, isUser: participantIdentity == localIdentity, text: text, isFinal: isFinal)
        if let position = index[key] {
            guard !turns[position].isFinal || isFinal else { return }
            turns[position] = turn
        } else {
            index[key] = turns.count
            turns.append(turn)
        }
    }
}
