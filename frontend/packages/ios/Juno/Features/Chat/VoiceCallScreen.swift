import AVFoundation
import LiveKit
import SwiftUI

/// The full-screen call. Text minimizes it to the call bar and the call goes on; End hangs up (ActiveCall).
struct VoiceCallScreen: View {
    @Environment(World.self) private var world
    let call: ActiveCall

    var body: some View {
        let controller = call.controller
        let agent = world.conversation(call.conversationId)?.agentIds?.first.flatMap(world.agent)
        VoiceCallView(agent: agent, state: controller.state, level: controller.level, turns: controller.transcript.turns, muted: controller.muted,
                      toggleMute: { Task { await controller.toggleMute() } },
                      showText: { call.presented = false },
                      end: { world.endCall() })
    }
}

/// The call in progress, owned by the app rather than by a screen: leaving the call screen (to type, to look at something)
/// keeps the call going behind a bar at the top, the way Phone and FaceTime do. Only End hangs up.
@MainActor @Observable
final class ActiveCall {
    let conversationId: String
    let controller = VoiceCallController()
    /// The full-screen call is showing; false while it is minimized to the bar.
    var presented = true
    private var task: Task<Void, Never>?

    init(conversationId: String) { self.conversationId = conversationId }

    func start(world: World) {
        task = Task { await connect(world: world) }
    }

    func end() async {
        task?.cancel()
        task = nil
        await controller.end()
    }

    /// A missing server or denied permission is shown rather than simulating a call.
    private func connect(world: World) async {
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

extension World {
    /// Calls the conversation's agent, or brings back the call already going with it. Another call is hung up first.
    func startCall(_ conversationId: String) {
        if let call, call.conversationId == conversationId {
            call.presented = true
            return
        }
        let previous = call
        let next = ActiveCall(conversationId: conversationId)
        call = next
        Task {
            await previous?.end()
            next.start(world: self)
        }
    }

    func endCall() {
        let ending = call
        call = nil
        Task { await ending?.end() }
    }
}

/// The minimized call: who you are talking to and what the call is doing; tap to go back to it, or hang up.
struct CallBar: View {
    @Environment(World.self) private var world
    let call: ActiveCall

    var body: some View {
        let name = world.conversation(call.conversationId)?.agentIds?.first.flatMap(world.agent)?.name ?? "Agent"
        HStack(spacing: 10) {
            Button {
                world.openChat(call.conversationId)
                call.presented = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: call.controller.muted ? "mic.slash.fill" : "waveform")
                        .symbolEffect(.variableColor.iterative, isActive: call.controller.state == .speaking)
                    Text(name).text(.sm, .semibold).lineLimit(1)
                    Text(call.controller.state.label).text(.sm).opacity(0.85).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Return to the call with \(name)")
            Button { world.endCall() } label: {
                Image(systemName: "phone.down.fill").text(.sm, .semibold)
                    .frame(width: 32, height: 32)
                    .background(Theme.danger, in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("End call")
        }
        .foregroundStyle(.white)
        .padding(.leading, 16).padding(.trailing, 6).padding(.vertical, 6)
        .background(Theme.success, in: .rect(cornerRadius: Radius.xxl))
        .padding(.horizontal, 12)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}
