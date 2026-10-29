import SwiftUI
import UIKit

/// Agent avatar: always one of the six animated characters — `avatar.character`, else a stable pick from the
/// agent id (defaultCharacter: FNV-1a hash, same as web lib/avatars.ts, so both platforms agree).
struct AvatarView: View {
    var agent: Agent?
    var size: CGFloat = 40
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let sprite = CharacterSprite.all[agentCharacter(agent)] ?? CharacterSprite.all["bean"]!
        let clip = reduceMotion || size < 40 ? nil : CharacterSprite.clip(for: agent?.status)
        if let clip {
            TimelineView(.animation(minimumInterval: 1 / sprite.fps)) { timeline in
                sprite.cell(clip, frame: Int(timeline.date.timeIntervalSinceReferenceDate * sprite.fps) % sprite.count, size: size)
            }
        } else {
            sprite.cell(nil, frame: 0, size: size)
        }
    }
}

/// A person's avatar: a neutral circle with their initials (web `AccountAvatar`, `bg-fg/10` with muted text). Colour belongs
/// to agents, so a person never gets a character or a tint. 44 in the People list, 88 on a person's page.
struct PersonAvatar: View {
    var name: String
    var size: CGFloat = 44

    var body: some View {
        Text(Self.initials(name))
            .font(.system(size: size * 0.38, weight: .medium))
            .foregroundStyle(Theme.fgMuted)
            .frame(width: size, height: size)
            .background(Theme.fg.opacity(0.1), in: .circle)
            .accessibilityHidden(true)
    }

    /// The first letters of the first two words ("Robin Lee" is "RL"); "?" for a blank name. Same as web `initialsOf`.
    static func initials(_ name: String) -> String {
        let letters = name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters.isEmpty ? "?" : letters
    }
}

/// Web lib/avatars.ts CHARACTER_ORDER + hashString (FNV-1a 32-bit); change together.
let characterOrder = ["mint", "blue", "purple", "pink", "star", "bean"]

func defaultCharacter(_ agentId: String) -> String {
    var hash: UInt32 = 0x811c9dc5
    for unit in agentId.utf16 { hash ^= UInt32(unit); hash = hash &* 0x01000193 }
    return characterOrder[Int(hash % UInt32(characterOrder.count))]
}

/// The character an agent is drawn as: the saved choice, else the id-derived default.
func agentCharacter(_ agent: Agent?) -> String {
    agent?.avatar?.character ?? defaultCharacter(agent?.id ?? "")
}

/// Shared six-character selector used by both agent creation and profile editing.
struct AvatarCharacterPicker: View {
    @Binding var selection: String
    var agentId: String
    var avatarSize: CGFloat = 72
    var cellHeight: CGFloat = 96
    var spacing: CGFloat = 14
    var accessibilityPrefix: String = "agent-avatar"
    var isDisabled = false

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            Text("Choose avatar").text(.lg, .semibold).foregroundStyle(Theme.fg)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
                ForEach(characterOrder, id: \.self) { character in
                    let selected = selection == character
                    Button { selection = character } label: {
                        VStack(spacing: 4) {
                            AvatarView(agent: Agent(id: agentId, avatar: Avatar(character: character)), size: avatarSize)
                                .frame(width: avatarSize, height: avatarSize)
                                .accessibilityHidden(true)
                            Text(character.capitalized)
                                .text(.xs, selected ? .semibold : .medium)
                                .foregroundStyle(Theme.fg)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: cellHeight)
                        .background(selected ? Theme.selected : Theme.panel, in: RoundedRectangle(cornerRadius: Radius.lg))
                        .overlay {
                            RoundedRectangle(cornerRadius: Radius.lg)
                                .stroke(selected ? Theme.fg.opacity(0.48) : Theme.border.opacity(0.45), lineWidth: selected ? 1.5 : 1)
                        }
                        .overlay(alignment: .topTrailing) {
                            if selected {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(Theme.fg)
                                    .padding(7)
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(RoundedRectangle(cornerRadius: Radius.lg))
                    }
                    .buttonStyle(.plain)
                    .disabled(isDisabled)
                    .accessibilityLabel("\(character.capitalized) avatar")
                    .accessibilityIdentifier("\(accessibilityPrefix)-\(character)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
    }
}

/// Soft per-character accent (web CHARACTER_TINT): home aurora, agent-card wash, live-screen ring.
func agentTint(_ agent: Agent?) -> Color {
    let hex: UInt32 = switch agentCharacter(agent) {
    case "mint": 0x4fd1b0
    case "blue": 0x5b8def
    case "purple": 0x9b7bf0
    case "pink": 0xf08bb4
    case "star": 0xf5b48a
    default: 0xf5c542
    }
    return Color(uiColor: UIColor(hex: hex))
}

/// The animated characters (web characters/index.ts): a poster (rest pose) plus one 8-column sprite atlas per clip
/// (`<name>-<clip>.webp`; layout mirrors characters/<name>/sprite.json). Atlases decode lazily, the first time a
/// clip plays, and stay cached. The cell is scaled so the rest-pose body fills the box and centred on it; the
/// bounce overflows the box, so nothing is clipped to it.
struct CharacterSprite {
    let name: String, poster: String
    let count: Int, fps: Double
    private let frame: CGFloat = 256, cols = 8
    private let body: (cx: CGFloat, cy: CGFloat, size: CGFloat)
    nonisolated(unsafe) private static var images: [String: UIImage] = [:]

    static let all: [String: CharacterSprite] = [
        "mint": CharacterSprite(name: "mint", poster: "mint-poster", count: 54, fps: 12, body: (140, 133, 178)),
        "blue": CharacterSprite(name: "blue", poster: "blue-poster", count: 54, fps: 12, body: (144, 138.5, 186)),
        "purple": CharacterSprite(name: "purple", poster: "purple-poster", count: 54, fps: 12, body: (137.5, 134.5, 186)),
        "pink": CharacterSprite(name: "pink", poster: "pink-poster", count: 54, fps: 12, body: (126.5, 130, 192)),
        "star": CharacterSprite(name: "star", poster: "star", count: 54, fps: 12, body: (134.5, 118.5, 197)),
        "bean": CharacterSprite(name: "bean", poster: "bean-poster", count: 54, fps: 12, body: (123.5, 117, 208)),
    ]

    /// Status → clip; idle (and anything unknown) rests on the poster.
    static func clip(for status: String?) -> String? {
        switch status {
        case "working": "working"
        case "needs_you": "needs_you"
        case "sleeping", "paused": "sleeping"
        case "error": "failed"
        default: nil
        }
    }

    private static func image(_ file: String) -> UIImage? {
        if let cached = images[file] { return cached }
        guard let path = Bundle.main.path(forResource: file, ofType: "webp"), let image = UIImage(contentsOfFile: path) else { return nil }
        images[file] = image
        return image
    }

    /// One 256pt cell of the poster (clip nil) or of a clip atlas, drawn into a `size` box.
    @ViewBuilder func cell(_ clip: String?, frame index: Int, size: CGFloat) -> some View {
        let k = size / body.size
        let col = CGFloat(index % Int(cols)), row = CGFloat(index / Int(cols))
        if let atlas = Self.image(clip.map { "\(name)-\($0)" } ?? poster) {
            let w = atlas.size.width * k, h = atlas.size.height * k
            ZStack(alignment: .topLeading) {
                Image(uiImage: atlas).resizable().frame(width: w, height: h)
                    .offset(x: -col * frame * k, y: -row * frame * k)
            }
            .frame(width: frame * k, height: frame * k, alignment: .topLeading)
            .clipped()
            .offset(x: size / 2 - body.cx * k, y: size / 2 - body.cy * k)
            .frame(width: size, height: size, alignment: .topLeading)
            .accessibilityHidden(true)
        } else {
            Color.clear.frame(width: size, height: size)
        }
    }
}
