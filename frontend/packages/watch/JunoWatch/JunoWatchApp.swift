import SwiftUI

@main
struct JunoWatchApp: App {
    @State private var session = WatchKeychain.load()

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
