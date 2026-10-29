import SwiftUI

/// The messaging platforms an agent can be reached on, with the small mark used in lists and chat headers.
enum ChannelPlatform: String, CaseIterable, Identifiable {
    case telegram, slack, discord, feishu
    var id: String { rawValue }

    init?(kind: String?) { self.init(rawValue: kind ?? "") }

    var name: String {
        switch self {
        case .telegram: "Telegram"
        case .slack: "Slack"
        case .discord: "Discord"
        case .feishu: "Feishu / Lark"
        }
    }

    var symbol: String {
        switch self {
        case .telegram: "paperplane.fill"
        case .slack: "number"
        case .discord: "gamecontroller.fill"
        case .feishu: "bubble.left.and.text.bubble.right.fill"
        }
    }

    var color: Color {
        switch self {
        case .telegram: Color(uiColor: UIColor(hex: UInt32(0x2AABEE)))
        case .slack: Color(uiColor: UIColor(hex: UInt32(0x4A154B)))
        case .discord: Color(uiColor: UIColor(hex: UInt32(0x5865F2)))
        case .feishu: Color(uiColor: UIColor(hex: UInt32(0x3370FF)))
        }
    }
}

/// A round platform mark: the server's logo, the colored symbol while it loads or when it fails. Decorative: the name is in the text beside it.
struct ChannelBadge: View {
    @Environment(World.self) private var world
    var platform: ChannelPlatform
    var size: CGFloat = 16

    var body: some View {
        RemoteImage(url: world.brandIconURL(platform.rawValue), maxSide: size) { phase in
            if let image = phase.image {
                image.resizable().aspectRatio(contentMode: .fit).frame(width: size, height: size).clipShape(.circle)
            } else {
                Image(systemName: platform.symbol)
                    .font(.system(size: size * 0.55, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(platform.color, in: .circle)
            }
        }
        .accessibilityHidden(true)
    }
}
