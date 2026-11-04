import AVFoundation
import LiveKit
import SwiftUI

/// The real call screen. A missing server or denied permission is shown rather than simulating a call.
struct VoiceCallScreen: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    @Environment(\.popPage) private var popPage
    @State private var controller = VoiceCallController()
    let conversationId: String

    var body: some View {
        let agent = world.conversation(conversationId)?.agentIds?.first.flatMap(world.agent)
        VoiceCallView(agent: agent, state: controller.state, level: controller.level, turns: controller.transcript.turns, muted: controller.muted,
                      toggleMute: { Task { await controller.toggleMute() } },
                      showText: close, end: close)
            .navigationBarTitleDisplayMode(.inline)
            .task { await start() }
            .onDisappear { Task { await controller.end() } }
    }

    private func close() {
        if let popPage { popPage() } else { dismiss() }
    }

    private func start() async {
        controller.begin()
        // Creates the SDK's audio manager now rather than on first use during the connect.
        AudioManager.prepare()
        guard await AVAudioApplication.requestRecordPermission() else {
            controller.showError("Turn on Microphone for Juno in Settings to call.")
            return
        }
        guard !Task.isCancelled else { return }
        controller.mark(.permission)
        do {
            let response = try await world.startVoiceCall(conversationId: conversationId)
            controller.mark(.token)
            guard let url = response.url, let token = response.token, let identity = response.participantIdentity,
                  !url.isEmpty, !token.isEmpty, !identity.isEmpty else { throw APIError.badServer }
            guard !Task.isCancelled else { return }
            await controller.connect(url: url, token: token, localIdentity: identity)
        } catch {
            guard !Task.isCancelled else { return }
            controller.showError("Voice calls are unavailable. Please try again later.")
        }
    }
}
