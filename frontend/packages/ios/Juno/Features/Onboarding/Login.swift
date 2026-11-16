import SwiftUI
import UIKit

/// Sign-in on one continuous screen (like Claude's): wordmark, Juno's idle animation and the introduction, with the
/// email field right on the welcome layout. Focusing a field or choosing Log in / Create account never switches
/// pages: the keyboard shrinks the viewport, the bean and the headline get smaller and move up, and the password
/// (and, for a new account, the name) open in place. Nothing auto-focuses.
struct LoginView: View {
    @Environment(World.self) private var world
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("email") private var email = ""
    /// nil = just the welcome layout with the email field and the two choices; otherwise the chosen flow, in place.
    @State private var mode: AuthMode?
    @State private var name = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    private enum Field { case name, email, password }

    private var register: Bool { mode == .register }
    /// Opening a flow makes space for its extra fields; keyboard resizing follows the viewport itself.
    private var compact: Bool { mode != nil }
    private var layoutAnimation: Animation? { reduceMotion ? nil : .spring(duration: 0.45, bounce: 0.12) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Theme.canvas.ignoresSafeArea()
            GeometryReader { proxy in
                ScrollView {
                    content(height: proxy.size.height)
                        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
                .scrollIndicators(.hidden)
                .scrollBounceBehavior(.basedOnSize)
                .scrollDismissesKeyboard(.interactively)
            }

            if mode != nil {
                Button { back() } label: {
                    Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).frame(width: 36, height: 36)
                }
                .buttonStyle(.glass).buttonBorderShape(.circle)
                .tint(Theme.fg)
                .padding(.leading, 16).padding(.top, 4)
                .transition(.opacity)
                .accessibilityLabel("Back")
            }
        }
        .animation(layoutAnimation, value: compact)
        .animation(layoutAnimation, value: mode)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: error)
    }

    /// The viewport height already excludes the keyboard, so the mark scales with what is actually left.
    private func content(height: CGFloat) -> some View {
        let markHeight: CGFloat = min(compact ? 72 : 150, max(48, height * 0.22))
        return VStack(spacing: 0) {
            Text("Juno").font(.system(size: 22, weight: .bold, design: .rounded)).tracking(-0.3).foregroundStyle(Theme.fg)
                .padding(.top, 12)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: compact ? 8 : 16)
            JunoMark(height: markHeight).frame(height: markHeight)
            Text("Your AI team, getting things done.")
                .font(.system(size: compact ? 20 : 26, weight: .semibold, design: .rounded)).tracking(-0.3)
                .multilineTextAlignment(.center).foregroundStyle(Theme.fg)
                .lineLimit(4).minimumScaleFactor(0.8)
                .frame(maxWidth: 320)
                .padding(.horizontal, 24)
                .padding(.top, compact ? 12 : 28)
            Spacer(minLength: compact ? 12 : 24)
            form
        }
    }

    private var form: some View {
        VStack(spacing: 10) {
            TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress)
                .textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .email)
                .submitLabel(mode == nil ? .done : .next)
                .onSubmit { if mode == nil { focus = nil } else { focus = register ? .name : .password } }
                .accessibilityLabel("Email")
                .inputField()
            if register {
                TextField("", text: $name, prompt: Text("Name").foregroundStyle(Theme.fgSubtle)).textContentType(.name).focused($focus, equals: .name)
                    .submitLabel(.next).onSubmit { focus = .password }.accessibilityLabel("Name")
                    .inputField().transition(.opacity)
            }
            if mode != nil {
                HStack(spacing: 0) {
                    Group {
                        if showPassword { TextField("Password", text: $password).textInputAutocapitalization(.never).autocorrectionDisabled() }
                        else { SecureField("Password", text: $password) }
                    }
                    .textContentType(register ? .newPassword : .password).focused($focus, equals: .password)
                    .submitLabel(.go).onSubmit { Task { await submit() } }
                    .accessibilityLabel("Password")
                    Button { showPassword.toggle() } label: {
                        Image(systemName: showPassword ? "eye.slash" : "eye").foregroundStyle(Theme.fgMuted).frame(width: 36, height: 28)
                    }
                    .accessibilityLabel(showPassword ? "Hide password" : "Show password")
                }
                .inputField().transition(.opacity)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .text(.sm).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4).transition(.opacity)
            }
            actions.padding(.top, 2)
        }
        .padding(.horizontal, 24).padding(.bottom, 16)
    }

    @ViewBuilder private var actions: some View {
        if let mode {
            VStack(spacing: 8) {
                Button { Task { await submit() } } label: {
                    HStack(spacing: 8) {
                        if busy { ProgressView().controlSize(.small) }
                        Text(register ? "Create account" : "Log in").text(.md, .semibold).foregroundStyle(Theme.primaryFg)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent).controlSize(.large)
                .disabled(busy || !ready)
                Button(register ? "Already have an account? Log in" : "New here? Create an account") {
                    self.mode = mode == .register ? .signIn : .register; password = ""; error = nil
                }
                .text(.sm).foregroundStyle(Theme.fgMuted)
            }
        } else {
            VStack(spacing: 12) {
                Button { choose(.signIn) } label: {
                    Text("Log in").text(.md, .semibold).foregroundStyle(Theme.primaryFg).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                Button { choose(.register) } label: {
                    Text("Create account").text(.md, .semibold).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
            }
            .controlSize(.large)
        }
    }

    /// Open the flow in place without forcing a keyboard when the person has not selected a field.
    private func choose(_ chosen: AuthMode) {
        mode = chosen
    }

    private func back() {
        focus = nil
        mode = nil; password = ""; error = nil
    }

    private var ready: Bool {
        mode != nil && !email.isEmpty && password.count >= (register ? 8 : 1) && (!register || !name.isEmpty)
    }

    private func submit() async {
        guard ready, !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let session = register
                ? try await API.signUp(name: name, email: email, password: password)
                : try await API.signIn(email: email, password: password)
            try await world.connect(session)
            SessionStore.save(session)
            password = ""
            // Sign-up creates the default agent and its chat: land in that chat, like Muse does.
            if register { world.openChat(world.defaultDirectChat?.id) }
        } catch {
            password = ""
            focus = .password
            self.error = friendly(error)
        }
    }

    /// Network failures say what to do; server answers (wrong password, email taken) pass through as written.
    private func friendly(_ error: Error) -> String {
        if error is URLError { return "Can't reach Juno. Check your connection." }
        return error.localizedDescription
    }
}

enum AuthMode: Hashable { case signIn, register }

/// Juno's idle animation on a soft warm wash; the poster stays still with Reduce Motion.
struct JunoMark: View {
    var height: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let sprite = CharacterSprite.all["bean"]!
        Group {
            if reduceMotion {
                sprite.cell(nil, frame: 0, size: height)
            } else {
                TimelineView(.animation(minimumInterval: 1 / sprite.fps)) { context in
                    sprite.cell("idle", frame: Int(context.date.timeIntervalSinceReferenceDate * sprite.fps) % sprite.count, size: height)
                }
            }
        }
        .background {
            RadialGradient(colors: [agentTint(Agent(id: "", avatar: Avatar(character: "bean"))).opacity(0.3), .clear],
                           center: .center, startRadius: 0, endRadius: height * 1.3)
                .frame(width: height * 2.6, height: height * 2.6)
        }
        // Decoration only: its per-frame animation must never sit in the way of a tap on the buttons.
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// More → Account: who is signed in, sign out, sign out.
struct AccountSection: View {
    @Environment(World.self) private var world

    var body: some View {
        Section("Account") {
            if let s = world.session {
                LabeledContent(s.name, value: s.email)
                Button("Sign out", role: .destructive) { world.signOut() }
            }
        }
    }
}
