import SwiftUI
import UIKit

/// A platform's picture in a rounded square: the connector's brand logo (served by the server as a PNG, the SF Symbol while
/// it loads or when it fails), a site's own icon (a signed URL) with the host's initial, Juno's bean, or an SF Symbol.
/// One resolution for the connector list, Today's unlock card, the decision card and the Permissions history.
struct BrandIcon: View {
    @Environment(World.self) private var world
    var catalogId: String?
    var url: URL?
    var host: String?
    var juno = false
    var symbol = "puzzlepiece.extension"
    var size: CGFloat = 36

    var body: some View {
        Group {
            if juno {
                Image("juno-bean").resizable().aspectRatio(contentMode: .fit).padding(size * 0.1)
            } else if let catalogId {
                RemoteImage(url: world.brandIconURL(catalogId), maxSide: size) { phase in
                    if let image = phase.image { image.resizable().aspectRatio(contentMode: .fit).frame(width: size * 0.6, height: size * 0.6) }
                    else { symbolImage }
                }
            } else if url != nil || host != nil {
                RemoteImage(url: url, maxSide: size) { phase in
                    if let image = phase.image { image.resizable().aspectRatio(contentMode: .fit).padding(size * 0.12) }
                    else { Text(String((host ?? "").replacingOccurrences(of: "www.", with: "").prefix(1)).uppercased()).text(.base, .semibold).foregroundStyle(Theme.fgMuted) }
                }
            } else {
                symbolImage
            }
        }
        .frame(width: size, height: size)
        .background(Theme.canvas, in: .rect(cornerRadius: size * 0.3))
        .overlay(RoundedRectangle(cornerRadius: size * 0.3).strokeBorder(Theme.border, lineWidth: 0.5))
        .clipShape(.rect(cornerRadius: size * 0.3))
    }
}

extension BrandIcon {
    fileprivate var symbolImage: some View { Image(systemName: symbol).text(size >= 36 ? .lg : .md).foregroundStyle(Theme.fgMuted) }
}
