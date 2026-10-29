import SwiftUI
import UIKit

/// Sign-in on one calm screen, no pushed page. Welcome: the Juno bean, the wordmark, one line, then "Log in" and
/// "Create account". Tapping either moves the same screen on: the bean shrinks to the top and the credentials form
/// takes the middle. The form sits in a scroll view so the keyboard shrinks the viewport instead of lifting the
/// screen, and it is short enough to stay visible above the keyboard.
struct LoginView: View {
    @State private var mode: AuthMode?
    @Namespace private var ns

    private let spring = Animation.spring(duration: 0.5, bounce: 0.18)

    var body: some View {
        ZStack(alignment: .topLeading) {
            Theme.canvas.ignoresSafeArea()
            ScrollView {
                if let mode {
                    CredentialsForm(mode: Binding(get: { mode }, set: { self.mode = $0 }), ns: ns)
                } else {
                    welcome.containerRelativeFrame(.vertical)
                }
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)

            if mode != nil {
                Button { withAnimation(spring) { mode = nil } } label: {
                    Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).frame(width: 36, height: 36)
                }
                .buttonStyle(.glass).buttonBorderShape(.circle)
                .tint(Theme.fg)
                .padding(.leading, 16).padding(.top, 4)
                .transition(.opacity)
                .accessibilityLabel("Back")
            }
        }
    }

    private var welcome: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            JunoMark(height: 150, ns: ns)
            VStack(spacing: 10) {
                Text("Juno").font(.system(size: 44, weight: .bold, design: .rounded)).tracking(-0.8).foregroundStyle(Theme.fg)
                Text("A team of agents, each with a computer of their own.")
                    .text(.lg).multilineTextAlignment(.center).foregroundStyle(Theme.fgMuted).frame(maxWidth: 280)
            }
            .padding(.top, 20)
            Spacer(minLength: 0)
            VStack(spacing: 12) {
                Button { withAnimation(spring) { mode = .signIn } } label: {
                    Text("Log in").text(.md, .semibold).foregroundStyle(Theme.primaryFg).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                Button { withAnimation(spring) { mode = .register } } label: {
                    Text("Create account").text(.md, .semibold).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
            }
            .controlSize(.large)
            .padding(.horizontal, 24).padding(.bottom, 8)
        }
        .transition(.opacity)
    }
}

enum AuthMode: Hashable { case signIn, register }

/// The brand mark: Juno's bean on a soft warm wash, floating a few points up and down (still with Reduce Motion).
struct JunoMark: View {
    var height: CGFloat
    var ns: Namespace.ID
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            Image("juno-bean").resizable().scaledToFit().frame(height: height)
                .offset(y: sin(t * 1.4) * height * 0.025)
        }
        .background {
            RadialGradient(colors: [agentTint(Agent(id: "", avatar: Avatar(character: "bean"))).opacity(0.3), .clear],
                           center: .center, startRadius: 0, endRadius: height * 1.3)
                .frame(width: height * 2.6, height: height * 2.6)
        }
        .matchedGeometryEffect(id: "mark", in: ns)
        // Decoration only: its per-frame animation must never sit in the way of a tap on the buttons.
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The credential form (web AccountForm) as the second state of the same screen: system text fields on glass,
/// a prominent submit, the server tucked under "Server", errors inline.
struct CredentialsForm: View {
    @Environment(World.self) private var world
    @AppStorage("server") private var server = "https://juno.example.com"
    @AppStorage("email") private var email = ""
    @Binding var mode: AuthMode
    var ns: Namespace.ID
    @State private var name = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var busy = false
    @State private var error: String?
    @State private var shown = false
    @State private var serverOpen = false
    @FocusState private var focus: Field?
    private enum Field { case name, email, password, server }

    private var register: Bool { mode == .register }

    var body: some View {
        VStack(spacing: 14) {
            JunoMark(height: 64, ns: ns).frame(height: 64).padding(.top, 2)
            VStack(spacing: 6) {
                Text(register ? "Create your account" : "Welcome back").font(.system(size: 28, weight: .bold, design: .rounded)).tracking(-0.4)
                    .foregroundStyle(Theme.fg)
                Text(register ? "Your agents and chats belong to your account." : "Log in to see what your agents are doing.")
                    .text(.base).multilineTextAlignment(.center).foregroundStyle(Theme.fgMuted)
            }
            .rise(shown, 0)
            .padding(.bottom, 4)
            VStack(spacing: 10) {
                if register {
                    TextField("", text: $name, prompt: Text("Name").foregroundStyle(Theme.fgSubtle)).textContentType(.name).focused($focus, equals: .name)
                        .submitLabel(.next).onSubmit { focus = .email }.accessibilityLabel("Name")
                        .inputField().rise(shown, 1)
                }
                TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .email)
                    .submitLabel(.next).onSubmit { focus = .password }.accessibilityLabel("Email")
                    .inputField().rise(shown, register ? 2 : 1)
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
                .inputField().rise(shown, register ? 3 : 2)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .text(.sm).foregroundStyle(Theme.danger).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4).transition(.opacity)
            }
            Button { Task { await submit() } } label: {
                HStack(spacing: 8) {
                    if busy { ProgressView().controlSize(.small) }
                    Text(busy ? "Please wait…" : register ? "Create account" : "Log in").text(.md, .semibold).foregroundStyle(Theme.primaryFg)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent).controlSize(.large)
            .disabled(busy || !ready)
            .rise(shown, 4, fades: false)
            Button(register ? "Already have an account? Log in" : "New here? Create an account") {
                withAnimation(.snappy(duration: 0.25)) { mode = register ? .signIn : .register; password = ""; error = nil }
            }
            .text(.sm).foregroundStyle(Theme.fgMuted)
            // A plain button row, not a DisclosureGroup: one tap toggles once, and the whole row is the target.
            VStack(alignment: .leading, spacing: 0) {
                Button { serverOpen.toggle() } label: {
                    HStack {
                        Text("Server")
                        Spacer()
                        Image(systemName: "chevron.right").text(.xs, .semibold)
                            .rotationEffect(.degrees(serverOpen ? 90 : 0))
                    }
                    .frame(minHeight: 44).contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Server").accessibilityValue(serverOpen ? "expanded" : "collapsed")
                if serverOpen {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("https://…", text: $server).keyboardType(.URL).textContentType(.URL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .server)
                            .submitLabel(.done).onSubmit { focus = nil }.accessibilityLabel("Server address")
                            .inputField()
                        Text("The default is the public Juno API. Point this at your own server to use it instead.")
                            .text(.xs).foregroundStyle(Theme.fgSubtle)
                    }
                    .padding(.top, 4)
                }
            }
            .text(.sm).foregroundStyle(Theme.fgMuted)
            .animation(.snappy(duration: 0.25), value: serverOpen)
        }
        .padding(.horizontal, 24).padding(.bottom, 16)
        .animation(.snappy(duration: 0.25), value: error)
        .onAppear {
            withAnimation(.easeOut(duration: 0.35).delay(0.12)) { shown = true }
            // Raise the keyboard once the screen has settled.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { focus = register ? .name : (email.isEmpty ? .email : .password) }
        }
    }

    private var ready: Bool { !email.isEmpty && password.count >= (register ? 8 : 1) && (!register || !name.isEmpty) }

    private func submit() async {
        guard ready, !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        guard let url = URL(string: server.trimmingCharacters(in: .whitespaces)), url.scheme?.hasPrefix("http") == true else {
            error = APIError.badServer.localizedDescription; serverOpen = true; return
        }
        do {
            let session = register
                ? try await API.signUp(server: url, name: name, email: email, password: password)
                : try await API.signIn(server: url, email: email, password: password)
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
        if error is URLError { return "Can't reach the server. Check your connection, or the address under Server." }
        return error.localizedDescription
    }
}

private extension View {
    /// Staggered fade-up for the form's rows (80 ms apart). A button rises without fading: a view at zero opacity
    /// takes no touches, so its first tap would be lost while the entrance plays.
    func rise(_ shown: Bool, _ index: Int, fades: Bool = true) -> some View {
        opacity(shown || !fades ? 1 : 0)
            .offset(y: shown ? 0 : 14)
            .animation(.easeOut(duration: 0.32).delay(0.1 + Double(index) * 0.08), value: shown)
    }

}

/// More → Account: who is signed in, sign out, sign out.
struct AccountSection: View {
    @Environment(World.self) private var world

    var body: some View {
        Section("Account") {
            if let s = world.session {
                LabeledContent(s.name, value: s.email)
                LabeledContent("Server", value: s.server.absoluteString)
                Button("Sign out", role: .destructive) { world.signOut() }
            }
        }
    }
}
