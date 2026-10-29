import SwiftUI
import UserNotifications
import os

// Push notifications (BACKEND §10.13). The backend pushes "<agent> needs you" for a new request and a banner when a
// chat run finishes. This file owns: the app delegate (token + delegate wiring), the device registration
// (POST/DELETE /v1/devices), and routing a tapped notification into the app.

let pushLog = Logger(subsystem: "io.github.nigelleong0703.juno", category: "push")

/// Routes a notification tap (or a banner received before the world exists) to the app.
/// A requestId opens the Needs-you queue; `screen: "feed"` (a feed source's brief) opens the Feed; otherwise a conversationId opens that chat.
@MainActor
final class PushRouter {
    static let shared = PushRouter()
    private weak var world: World?
    private var pending: (conversationId: String?, requestId: String?, screen: String?)?

    func attach(_ world: World) {
        self.world = world
        if let pending {
            self.pending = nil
            open(conversationId: pending.conversationId, requestId: pending.requestId, screen: pending.screen)
        }
    }

    func open(conversationId: String?, requestId: String?, screen: String? = nil) {
        guard let world else {
            // Cold launch from a tap: the delegate runs before the root view attaches the world.
            pending = (conversationId, requestId, screen)
            return
        }
        if requestId != nil {
            world.sheet = .queue
        } else if screen == "feed" {
            world.tab = "feed"
        } else {
            world.openChat(conversationId)
        }
    }
}

/// Notification permission (local notifications need it on any team). Signing in only registers when it is already
/// granted; the system prompt waits for `askForPermission`, the first moment a notification is useful. With JUNO_PUSH on
/// (paid team, see Config/Juno.xcconfig) it also registers the APNs token and keeps the backend row in step.
/// Without it nothing here touches APNs, so a free-team build signs and installs.
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    #if JUNO_PUSH
    private struct Registration: Encodable {
        var platform = "ios"
        let token: String
        let environment: String
        let bundleId: String
    }

    private var api: API?
    private var token: String?
    #endif

    func signedIn(_ api: API) {
        Task { @MainActor in
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            #if JUNO_PUSH
            if status == .authorized || status == .provisional { UIApplication.shared.registerForRemoteNotifications() }
            #endif
        }
        #if JUNO_PUSH
        self.api = api
        if let token { Task { await upload(token) } }
        #endif
    }

    /// The system prompt, once: a no-op when the user has already answered.
    func askForPermission() {
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            guard await center.notificationSettings().authorizationStatus == .notDetermined else { return }
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            #if JUNO_PUSH
            if granted { UIApplication.shared.registerForRemoteNotifications() }
            #else
            _ = granted
            #endif
        }
    }

    /// The APNs token arrived from the system (delegate callback).
    func didRegister(deviceToken: Data) {
        #if JUNO_PUSH
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        token = hex
        if api != nil { Task { await upload(hex) } }
        #endif
    }

    /// Before sign-out clears the session: the backend forgets this phone for the account that is leaving.
    func signingOut() {
        #if JUNO_PUSH
        guard let api, let token else { return }
        self.api = nil
        Task { try? await api.delete("/v1/devices/\(token)") }
        #endif
    }

    #if JUNO_PUSH
    private func upload(_ token: String) async {
        guard let api else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let body = Registration(token: token, environment: environment, bundleId: Bundle.main.bundleIdentifier ?? "")
        do {
            try await api.post("/v1/devices", body)
        } catch {
            pushLog.info("device registration failed: \(error.localizedDescription, privacy: .public)")
        }
    }
    #endif
}

/// Local notifications from the event stream: allowed on a free team, fired only while the app is alive but not on
/// screen (backgrounded briefly). With JUNO_PUSH the backend pushes the same events, so local ones are skipped.
enum LocalNotice {
    @MainActor
    static func post(title: String, body: String, conversationId: String?, requestId: String?, id: String) {
        #if !JUNO_PUSH
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        var info: [String: String] = [:]
        if let conversationId { info["conversationId"] = conversationId; content.threadIdentifier = conversationId }
        if let requestId { info["requestId"] = requestId }
        content.userInfo = info
        // Same id replaces: a request or run that updates twice shows one banner.
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { _ in }
        #endif
    }
}
