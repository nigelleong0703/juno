import SwiftUI
import UIKit

/// Whether the first-launch onboarding shows. `-onboarding YES` forces it (screenshots), `-onboarding NO` skips it
/// (UI tests that start at the login screen); otherwise it shows until the user has finished or skipped it once.
enum OnboardingGate {
    static var shouldShow: Bool {
        let d = UserDefaults.standard
        switch d.string(forKey: "onboarding") {
        case "YES": return true
        case "NO": return false
        default: return !d.bool(forKey: "onboardingSeen")
        }
    }
    static func markSeen() { UserDefaults.standard.set(true, forKey: "onboardingSeen") }
}

// MARK: - Launch

/// The first SwiftUI frame. It repeats the static launch screen exactly (UILaunchScreen: `LaunchBackground` colour,
/// `juno-bean` centred at its natural size), then the bean pops once and the frame fades into the app: 0.6 s, never
/// blocks touches. Reduce Motion: a plain fade. `-splash hold` freezes it on the first frame for screenshots.
struct SplashOverlay: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scale: CGFloat = 1
    @State private var faded = false
    @State private var gone = false

    var body: some View {
        if !gone {
            ZStack {
                Color("LaunchBackground")
                Image("juno-bean").scaleEffect(scale)
            }
            .ignoresSafeArea()
            .opacity(faded ? 0 : 1)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .task {
                guard UserDefaults.standard.string(forKey: "splash") != "hold" else { return }
                if reduceMotion {
                    withAnimation(.easeOut(duration: 0.2)) { faded = true }
                    try? await Task.sleep(for: .milliseconds(220))
                } else {
                    withAnimation(.spring(duration: 0.28, bounce: 0.5)) { scale = 1.1 }
                    try? await Task.sleep(for: .milliseconds(240))
                    withAnimation(.easeIn(duration: 0.3)) { faded = true; scale = 0.94 }
                    try? await Task.sleep(for: .milliseconds(320))
                }
                gone = true
            }
        }
    }
}

// MARK: - Onboarding

/// Three short pages before the first sign-in: a team that works for you, each with a computer of their own, you
/// stay in control. Big type, one character-led picture per page, Skip always visible.
struct OnboardingView: View {
    var done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = 0

    private struct Page { let title: String, text: String }
    private let pages = [
        Page(title: "A team that works for you", text: "Give each agent a job. They keep going while you get on with your day."),
        Page(title: "Every agent has its own computer", text: "A browser, files and a terminal, always on. Watch them work any time."),
        Page(title: "You stay in control", text: "Agents ask before anything important. Approve, or take over the screen yourself."),
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button("Skip", action: done)
                    .text(.lg, .medium).foregroundStyle(Theme.fgMuted)
                    .padding(.horizontal, 24).frame(height: 44)
            }
            TabView(selection: $page) {
                ForEach(pages.indices, id: \.self) { i in
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        art(i)
                            .frame(height: 300)
                            .scaleEffect(page == i || reduceMotion ? 1 : 0.88)
                            .opacity(page == i || reduceMotion ? 1 : 0.4)
                            .animation(.spring(duration: 0.5, bounce: 0.15), value: page)
                            .accessibilityHidden(true)
                        VStack(spacing: 12) {
                            Text(pages[i].title)
                                .font(.system(size: 32, weight: .bold, design: .rounded)).tracking(-0.4)
                                .multilineTextAlignment(.center).foregroundStyle(Theme.fg)
                            Text(pages[i].text)
                                .text(.lg).multilineTextAlignment(.center).foregroundStyle(Theme.fgMuted)
                        }
                        .padding(.horizontal, 32).padding(.top, 28)
                        Spacer(minLength: 0)
                    }
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .never))
            Button {
                if page == pages.count - 1 { done() } else { withAnimation(.snappy) { page += 1 } }
            } label: {
                Text(page == pages.count - 1 ? "Get started" : "Continue").text(.md, .semibold).foregroundStyle(Theme.primaryFg).frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent).controlSize(.large)
            .padding(.horizontal, 24).padding(.bottom, 8)
        }
        .background(Theme.canvas.ignoresSafeArea())
        .onAppear {
            UIPageControl.appearance().currentPageIndicatorTintColor = UIColor.label
            UIPageControl.appearance().pageIndicatorTintColor = UIColor.label.withAlphaComponent(0.2)
        }
    }

    @ViewBuilder private func art(_ i: Int) -> some View {
        switch i {
        case 0:
            ZStack {
                Wash(color: agentTint(Agent(id: "", avatar: Avatar(character: "pink"))))
                Bob(phase: 0.0) { figure("mint", 96) }.offset(x: -92, y: 36)
                Bob(phase: 2.1) { figure("blue", 96) }.offset(x: 92, y: 36)
                Bob(phase: 1.0) { figure("pink", 128) }.offset(y: -14)
            }
        case 1:
            ZStack {
                Wash(color: agentTint(Agent(id: "", avatar: Avatar(character: "purple"))))
                VStack(spacing: 14) {
                    Bob(phase: 0.5) { figure("purple", 112, status: "working") }
                    HStack(spacing: 18) {
                        tool("globe", "Browser"); tool("terminal", "Terminal"); tool("folder", "Files")
                    }
                    .padding(.horizontal, 20).padding(.vertical, 14)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))
                }
            }
        default:
            ZStack {
                Wash(color: agentTint(Agent(id: "", avatar: Avatar(character: "bean"))))
                VStack(spacing: 14) {
                    Bob(phase: 1.5) { figure("bean", 116, status: "needs_you") }
                    VStack(spacing: 12) {
                        Text("Send the signed contract?").text(.md, .medium).foregroundStyle(Theme.fg)
                        HStack(spacing: 10) {
                            Label("Approve", systemImage: "checkmark").padding(.horizontal, 14).padding(.vertical, 8)
                                .glassEffect(.regular.tint(Theme.success.opacity(0.35)), in: .capsule)
                            Label("Take over", systemImage: "hand.raised").padding(.horizontal, 14).padding(.vertical, 8)
                                .glassEffect(.regular, in: .capsule)
                        }
                        .text(.sm, .medium).foregroundStyle(Theme.fg)
                    }
                    .padding(.horizontal, 22).padding(.vertical, 16)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))
                }
            }
        }
    }

    private func figure(_ character: String, _ size: CGFloat, status: String? = nil) -> some View {
        AvatarView(agent: Agent(id: "", status: status, avatar: Avatar(character: character)), size: size)
    }

    private func tool(_ symbol: String, _ title: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol).font(.system(size: 20, weight: .regular)).frame(height: 26)
            Text(title).text(.xs, .medium)
        }
        .foregroundStyle(Theme.fg).frame(width: 64)
    }
}

/// A soft colour wash behind a page's characters (their web tint), so the page is not just white space.
private struct Wash: View {
    var color: Color
    var body: some View {
        RadialGradient(colors: [color.opacity(0.28), color.opacity(0)], center: .center, startRadius: 0, endRadius: 170)
            .frame(width: 340, height: 340)
    }
}

/// Gentle up-and-down float for a character; still when Reduce Motion is on.
private struct Bob<Content: View>: View {
    var phase: Double
    @ViewBuilder var content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            content.offset(y: sin(t * 1.6 + phase) * 6)
        }
        .allowsHitTesting(false)
    }
}
