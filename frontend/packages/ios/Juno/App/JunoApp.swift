import SwiftUI
import UIKit
import UserNotifications

@main
struct JunoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var world = World()

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--voice-call-preview") {
                VoiceCallPreview()
            } else {
                appRoot
            }
            #else
            appRoot
            #endif
        }
    }

    private var appRoot: some View {
        ZStack {
            RootView().environment(world).tint(Theme.primary)
                .onAppear { PushRouter.shared.attach(world) }
            SplashOverlay()
        }
    }
}

#if DEBUG
/// Explicitly launched only for simulator design verification; it never connects audio or a server.
private struct VoiceCallPreview: View {
    @State private var muted = false
    @State private var state: VoiceCallState = {
        let args = ProcessInfo.processInfo.arguments
        let name = args.firstIndex(of: "--voice-call-preview").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        return switch name {
        case "connecting": .connecting
        case "thinking": .thinking
        case "speaking": .speaking
        case "ended": .ended
        default: .listening
        }
    }()
    private let turns = [
        VoiceCallView.Turn(id: "1", isUser: true, text: "我今天有点累，想找个人聊聊天。", isFinal: true),
        VoiceCallView.Turn(id: "2", isUser: false, text: "我在呢。我们随便聊聊，好吗？", isFinal: true),
        VoiceCallView.Turn(id: "3", isUser: true, text: "嗯，今天开了好多会", isFinal: false),
    ]
    var body: some View {
        // The level is synthetic here (a slow wave); a real call feeds the controller's measured audio level.
        TimelineView(.animation(minimumInterval: 1 / 20)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            VoiceCallView(agent: Agent(id: "preview", name: "Juno", avatar: Avatar(character: "bean")),
                          state: state, level: Float(0.5 + 0.4 * sin(t * 5) * sin(t * 1.3)), turns: turns, muted: muted,
                          toggleMute: { muted.toggle() },
                          showText: { state = .thinking },
                          end: { state = .ended })
        }
    }
}
#endif

/// Portrait everywhere; a screen that wants landscape (the full-screen computer) unlocks it while it's open.
/// Info.plist lists every orientation the app may use; this delegate narrows it at run time.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Set here, not after sign-in: a tap that cold-launches the app is delivered during launch.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushRegistrar.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Harmless: the app works without a token (free team, simulator, offline).
        pushLog.info("remote notification registration failed: \(error.localizedDescription, privacy: .public)")
    }

    /// Banners show while the app is in the foreground too.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let conversationId = info["conversationId"] as? String
        let requestId = info["requestId"] as? String
        let screen = info["screen"] as? String
        Task { @MainActor in PushRouter.shared.open(conversationId: conversationId, requestId: requestId, screen: screen) }
        completionHandler()
    }

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        OrientationLock.mask
    }
}

enum OrientationLock {
    @MainActor static var mask: UIInterfaceOrientationMask = .portrait

    /// Allow `mask`, then ask iOS to re-read it (and rotate back to portrait when locking again).
    @MainActor static func set(_ newMask: UIInterfaceOrientationMask) {
        mask = newMask
        guard let scene = UIApplication.shared.connectedScenes.first(where: { $0 is UIWindowScene }) as? UIWindowScene else { return }
        scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        if newMask == .portrait { scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) }
    }
}

extension View {
    /// This screen may rotate; leaving it locks the app back to portrait.
    func allowsLandscape() -> some View {
        onAppear { OrientationLock.set(.allButUpsideDown) }
            .onDisappear { OrientationLock.set(.portrait) }
    }
}
