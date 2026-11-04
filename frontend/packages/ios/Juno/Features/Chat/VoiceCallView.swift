import SwiftUI

/// The presentation of an in-app call. The call controller owns the session and passes only plain values: the call
/// state, a smoothed 0...1 audio level and the turns of this call.
struct VoiceCallView: View {
    struct Turn: Identifiable, Equatable {
        let id: String
        let isUser: Bool
        let text: String
        let isFinal: Bool
    }

    let agent: Agent?
    let state: VoiceCallState
    let level: Float
    let turns: [Turn]
    let muted: Bool
    let toggleMute: () -> Void
    let showText: () -> Void
    let end: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var entered = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(agent?.name ?? "Agent").text(.base, .semibold)
                Spacer()
            }
            .padding(.horizontal, 24).padding(.top, 16)
            .opacity(entered ? 1 : 0)

            Spacer(minLength: 16)
            CallOrb(agent: agent, state: state, level: level, muted: muted)
                .scaleEffect(entered || reduceMotion ? 1 : 0.82)
                .opacity(entered ? 1 : 0)
            Text(state.label).text(.sm).foregroundStyle(statusColor)
                .contentTransition(.opacity)
                .padding(.top, 8)
                .animation(.smooth(duration: 0.25), value: state)
                .accessibilityLabel(state.label)
            Spacer(minLength: 16)

            Divider().padding(.horizontal, 24).opacity(entered ? 1 : 0)
            transcript
                .frame(maxHeight: .infinity)
                .opacity(entered ? 1 : 0)

            HStack(alignment: .top, spacing: 20) {
                CallControl(symbol: muted ? "mic.slash.fill" : "mic.fill", label: muted ? "Unmute" : "Mute", action: toggleMute)
                CallControl(symbol: "keyboard", label: "Text", action: showText)
                CallControl(symbol: "phone.down.fill", label: "End call", destructive: true, action: end)
            }
            .padding(.top, 20).padding(.bottom, 28)
            .offset(y: entered || reduceMotion ? 0 : 56)
            .opacity(entered ? 1 : 0)
        }
        .background(Theme.canvas)
        .task {
            guard !entered else { return }
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.6, dampingFraction: 0.82)) { entered = true }
        }
    }

    private var statusColor: Color {
        if case .failed = state { return Theme.danger }
        return Theme.fgMuted
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 24) {
                    ForEach(turns) { turn in
                        VStack(alignment: turn.isUser ? .trailing : .leading, spacing: 6) {
                            Text(turn.isUser ? "You" : (agent?.name ?? "Agent"))
                                .text(.xs, .medium).foregroundStyle(Theme.fgMuted)
                            Text(turn.text).text(.base)
                                .foregroundStyle(turn.isFinal ? Theme.fg : Theme.fgMuted)
                                .multilineTextAlignment(turn.isUser ? .trailing : .leading)
                                .animation(.easeOut(duration: 0.3), value: turn.isFinal)
                        }
                        .frame(maxWidth: .infinity, alignment: turn.isUser ? .trailing : .leading)
                        .id(turn.id)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 16)))
                    }
                }
                .padding(.horizontal, 32).padding(.vertical, 24)
                .animation(.smooth(duration: 0.3), value: turns.map(\.id))
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: turns) { _, latest in
                guard let last = latest.last else { return }
                withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }
}

/// The avatar with a halo that shows the call state: it follows your level while listening and the agent's while
/// speaking, breathes slowly while thinking and pulses gently while connecting. With Reduce Motion it only changes
/// opacity.
private struct CallOrb: View {
    let agent: Agent?
    let state: VoiceCallState
    let level: Float
    let muted: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let size: CGFloat = 164

    var body: some View {
        let tint = agentTint(agent)
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
            let phase = reduceMotion ? 0 : sin(timeline.date.timeIntervalSinceReferenceDate * 2 * .pi / period)
            let breath = CGFloat(phase * 0.5 + 0.5)
            let amount = CGFloat(state.followsLevel ? level : 0)
            ZStack {
                Circle().fill(tint.opacity(haloOpacity(outer: true, amount: amount, breath: breath)))
                    .frame(width: size, height: size)
                    .scaleEffect(1.28 + 0.32 * amount + 0.08 * breathing(breath))
                Circle().fill(tint.opacity(haloOpacity(outer: false, amount: amount, breath: breath)))
                    .frame(width: size, height: size)
                    .scaleEffect(1.1 + 0.16 * amount + 0.05 * breathing(breath))
                AvatarView(agent: agent, size: size)
                    .frame(width: size, height: size)
                    .scaleEffect(1 + 0.03 * amount + 0.02 * breathing(breath))
                    .opacity(muted && state == .listening ? 0.6 : 1)
            }
            .frame(width: size * 1.7, height: size * 1.7)
        }
        .animation(.smooth(duration: 0.5), value: state)
        .animation(.linear(duration: 0.08), value: level)
        .animation(.smooth(duration: 0.3), value: muted)
        .accessibilityHidden(true)
    }

    /// Seconds per breath: thinking is a slow pulse, connecting a little quicker and shallower.
    private var period: Double { state == .thinking ? 2.8 : 1.8 }

    /// Only connecting and thinking breathe; level states move with the audio.
    private func breathing(_ breath: CGFloat) -> CGFloat {
        switch state {
        case .thinking: breath
        case .connecting: breath * 0.6
        default: 0
        }
    }

    private func haloOpacity(outer: Bool, amount: CGFloat, breath: CGFloat) -> Double {
        let base: Double = switch state {
        case .listening: muted ? 0.04 : 0.1 + 0.25 * Double(amount)
        case .speaking: 0.14 + 0.3 * Double(amount)
        case .thinking: 0.12 + 0.12 * Double(breath)
        case .connecting: 0.06 + 0.1 * Double(breath)
        case .ended, .failed: 0
        }
        return outer ? base * 0.55 : base
    }
}

#if DEBUG
private let previewAgent = Agent(id: "preview", avatar: Avatar(character: "mint"))
private let previewTurns: [VoiceCallView.Turn] = [
    .init(id: "1", isUser: true, text: "Can you summarise today's outreach replies?", isFinal: true),
    .init(id: "2", isUser: false, text: "Three replies came in. Two want a demo this week.", isFinal: true),
    .init(id: "3", isUser: true, text: "Book the first one for Thursday", isFinal: false)
]

private func previewCall(_ state: VoiceCallState, level: Float = 0, muted: Bool = false,
                         turns: [VoiceCallView.Turn] = previewTurns) -> some View {
    VoiceCallView(agent: previewAgent, state: state, level: level, turns: turns, muted: muted,
                  toggleMute: {}, showText: {}, end: {})
}

#Preview("Connecting") { previewCall(.connecting, turns: []) }
#Preview("Listening") { previewCall(.listening, level: 0.6) }
#Preview("Listening muted") { previewCall(.listening, muted: true) }
#Preview("Thinking") { previewCall(.thinking) }
#Preview("Speaking") { previewCall(.speaking, level: 0.7) }
#Preview("Ended") { previewCall(.ended) }
#Preview("Failed") { previewCall(.failed("The agent is unavailable. Please try again."), turns: []) }
#endif
