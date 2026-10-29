import SwiftUI
import UIKit

/// The animated characters, the same art the iPhone app uses (`packages/ios/Juno/Characters`, converted to HEIC by scripts/make-characters.sh because watchOS cannot decode WebP):
/// one 8-column atlas of 256 pt cells per clip, 54 frames at 12 fps. The cell is scaled so the rest-pose body fills
/// the box and centred on it; the bounce overflows the box, so nothing is clipped to it.
struct CharacterSprite {
    let name: String
    let body: (cx: CGFloat, cy: CGFloat, size: CGFloat)
    static let count = 54
    static let fps = 12.0
    private static let frame: CGFloat = 256, cols = 8

    static let all: [String: CharacterSprite] = [
        "mint": CharacterSprite(name: "mint", body: (140, 133, 178)),
        "blue": CharacterSprite(name: "blue", body: (144, 138.5, 186)),
        "purple": CharacterSprite(name: "purple", body: (137.5, 134.5, 186)),
        "pink": CharacterSprite(name: "pink", body: (126.5, 130, 192)),
        "star": CharacterSprite(name: "star", body: (134.5, 118.5, 197)),
        "bean": CharacterSprite(name: "bean", body: (123.5, 117, 208)),
    ]

    /// Web lib/avatars.ts CHARACTER_ORDER + hashString (FNV-1a 32-bit): the character an agent without a saved choice gets.
    static let order = ["mint", "blue", "purple", "pink", "star", "bean"]
    static func defaultCharacter(_ agentId: String) -> String {
        var hash: UInt32 = 0x811c9dc5
        for unit in agentId.utf16 { hash ^= UInt32(unit); hash = hash &* 0x01000193 }
        return order[Int(hash % UInt32(order.count))]
    }

    /// Atlases are 2048x1792 (about 14 MB decoded), so only the two most recent stay in memory.
    @MainActor private static var images: [(file: String, image: UIImage)] = []

    @MainActor private static func image(_ file: String) -> UIImage? {
        if let hit = images.first(where: { $0.file == file }) { return hit.image }
        guard let path = Bundle.main.path(forResource: file, ofType: "heic"), let image = UIImage(contentsOfFile: path) else { return nil }
        images = Array((images + [(file, image)]).suffix(2))
        return image
    }

    @MainActor @ViewBuilder func cell(_ clip: String, frame index: Int, size: CGFloat) -> some View {
        let k = size / body.size
        let col = CGFloat(index % Self.cols), row = CGFloat(index / Self.cols)
        if let atlas = Self.image("\(name)-\(clip)") {
            ZStack(alignment: .topLeading) {
                Image(uiImage: atlas).resizable().frame(width: atlas.size.width * k, height: atlas.size.height * k)
                    .offset(x: -col * Self.frame * k, y: -row * Self.frame * k)
            }
            .frame(width: Self.frame * k, height: Self.frame * k, alignment: .topLeading)
            .clipped()
            .offset(x: size / 2 - body.cx * k, y: size / 2 - body.cy * k)
            .frame(width: size, height: size, alignment: .topLeading)
        } else {
            Color.clear.frame(width: size, height: size)
        }
    }
}

struct SpriteView: View {
    var character: String
    var clip: String
    var size: CGFloat
    @State private var frame = 0

    var body: some View {
        let sprite = CharacterSprite.all[character] ?? CharacterSprite.all["bean"]!
        sprite.cell(clip, frame: frame, size: size)
            // TimelineView(.animation) does not tick on watchOS, so the frame is advanced by hand at the clip's rate.
            .task(id: clip) {
                frame = 0
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1 / CharacterSprite.fps))
                    frame = (frame + 1) % CharacterSprite.count
                }
            }
    }
}
