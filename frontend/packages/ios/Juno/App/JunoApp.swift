import SwiftUI
import UIKit
import UserNotifications

@main
struct JunoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var world = World()

    var body: some Scene {
        WindowGroup {
            ZStack {
                RootView().environment(world).tint(Theme.primary) // the web is neutral: no blue anywhere
                    .onAppear { PushRouter.shared.attach(world) }
                SplashOverlay()
            }
        }
    }
}

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
