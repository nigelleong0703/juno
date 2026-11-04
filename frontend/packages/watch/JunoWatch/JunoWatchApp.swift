import SwiftUI

@main
struct JunoWatchApp: App {
    // The build's server wins over the one saved at pairing time: the token stays valid when the address of the same
    // backend changes (LAN → public https), and a stale saved address otherwise times out forever.
    @State private var session = WatchKeychain.load().map { WatchSession(server: WatchServer.url, token: $0.token) }

    init() {
        // The voice models load in the background from launch, never on the first tap.
        _ = VoiceModels.loading
    }

    var body: some Scene {
        WindowGroup {
            if let session {
                CompanionView(session: session) {
                    WatchKeychain.save(nil)
                    self.session = nil
                }
            } else {
                PairingView(server: WatchServer.url) { paired in
                    WatchKeychain.save(paired)
                    session = paired
                }
            }
        }
    }
}
