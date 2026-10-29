import ImageIO
import SwiftUI
import UIKit

/// Remote pictures (feed, source icons, item images): decoded once, kept in memory, downsampled to the size they are
/// drawn at, and fetched through a dedicated disk cache. SwiftUI's AsyncImage has no decoded-image cache and the
/// default URLCache is tiny, so every scroll or reopen of the Feed loaded the pictures again.
@MainActor
final class ImageCache {
    static let shared = ImageCache()

    typealias Loader = @Sendable (URL) async throws -> Data

    private let memory = NSCache<NSString, UIImage>()
    private var inflight: [String: Task<UIImage?, Never>] = [:]
    private let loader: Loader

    init(loader: @escaping Loader = ImageCache.network, memoryLimit: Int = 100 * 1024 * 1024) {
        self.loader = loader
        memory.totalCostLimit = memoryLimit
    }

    /// 50 MB in memory, 300 MB on disk (Caches), cached responses preferred over the network.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.urlCache = URLCache(memoryCapacity: 50 * 1024 * 1024, diskCapacity: 300 * 1024 * 1024, directory: nil)
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.httpCookieStorage = nil
        return URLSession(configuration: config)
    }()

    nonisolated static let network: Loader = { url in
        let (data, response) = try await session.data(from: url)
        guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true else { throw URLError(.badServerResponse) }
        return data
    }

    private func key(_ url: URL, _ maxPixel: CGFloat) -> String { "\(url.absoluteString)|\(Int((maxPixel / 64).rounded(.up)) * 64)" }

    /// The decoded picture when it is already in memory.
    func cached(_ url: URL, maxPixel: CGFloat) -> UIImage? { memory.object(forKey: key(url, maxPixel) as NSString) }

    /// The picture at no more than `maxPixel` on its long side; nil when it cannot be loaded or decoded. Concurrent
    /// requests for the same picture share one load.
    func image(_ url: URL, maxPixel: CGFloat) async -> UIImage? {
        let k = key(url, maxPixel)
        if let hit = memory.object(forKey: k as NSString) { return hit }
        if let running = inflight[k] { return await running.value }
        let loader = loader
        let task = Task<UIImage?, Never> {
            guard let data = try? await loader(url) else { return nil }
            return await Task.detached { Self.downsample(data, maxPixel: maxPixel) }.value
        }
        inflight[k] = task
        let image = await task.value
        inflight[k] = nil
        if let image { memory.setObject(image, forKey: k as NSString, cost: Int(image.size.width * image.size.height * image.scale * image.scale * 4)) }
        return image
    }

    nonisolated static func downsample(_ data: Data, maxPixel: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

enum RemoteImagePhase {
    case loading, failure
    case image(Image)
    var image: Image? { if case .image(let image) = self { image } else { nil } }
    var error: Bool { if case .failure = self { true } else { false } }
}

/// AsyncImage's phases, served from `ImageCache`. `maxSide` is the longest side it is drawn at, in points.
struct RemoteImage<Content: View>: View {
    var url: URL?
    var maxSide: CGFloat = 440
    var content: (RemoteImagePhase) -> Content

    init(url: URL?, maxSide: CGFloat = 440, @ViewBuilder content: @escaping (RemoteImagePhase) -> Content) {
        self.url = url; self.maxSide = maxSide; self.content = content
    }

    @Environment(\.displayScale) private var scale
    @State private var phase = RemoteImagePhase.loading

    var body: some View {
        content(phase)
            .task(id: url) {
                guard let url else { phase = .failure; return }
                let pixels = maxSide * scale
                if let hit = ImageCache.shared.cached(url, maxPixel: pixels) { phase = .image(Image(uiImage: hit)); return }
                phase = .loading
                if let image = await ImageCache.shared.image(url, maxPixel: pixels) { phase = .image(Image(uiImage: image)) } else { phase = .failure }
            }
    }
}
