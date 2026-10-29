import SwiftUI

/// Shows a short code; the signed-in iPhone app approves it (Settings > Add Apple Watch) and the watch receives its own session.
struct PairingView: View {
    let server: URL
    let onPaired: (WatchSession) -> Void
    @State private var code: String?
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 8) {
            if let code {
                Text("On your iPhone: Settings, Add Apple Watch").font(.footnote).multilineTextAlignment(.center)
                Text(code).font(.system(.title3, design: .monospaced).bold()).minimumScaleFactor(0.6)
            } else if let failure {
                Text(failure).font(.footnote).multilineTextAlignment(.center)
                Button("Try again") { self.failure = nil }
            } else {
                ProgressView()
            }
        }
        .task(id: failure) { if failure == nil { await pair() } }
    }

    private func pair() async {
        let client = WatchClient(server: server)
        do {
            let issued = try await client.requestDeviceCode()
            code = Self.format(issued.userCode)
            var interval = max(issued.interval ?? 5, 5)
            let deadline = Date().addingTimeInterval(TimeInterval(issued.expiresIn))
            while !Task.isCancelled, Date() < deadline {
                try await Task.sleep(for: .seconds(interval))
                do {
                    let token = try await client.redeemDeviceCode(issued.deviceCode)
                    onPaired(WatchSession(server: server, token: token))
                    return
                } catch let error as WatchAPIError where error.code == "authorization_pending" {
                    continue
                } catch let error as WatchAPIError where error.code == "slow_down" {
                    interval += 5
                }
            }
            if !Task.isCancelled { code = nil; failure = "Code expired." }
        } catch is CancellationError {
        } catch {
            code = nil
            failure = error.localizedDescription
        }
    }

    /// `K7QM4X2D` -> `K7QM-4X2D`.
    static func format(_ raw: String) -> String {
        guard raw.count > 4, !raw.contains("-") else { return raw }
        return raw.prefix(4) + "-" + raw.dropFirst(4)
    }
}
