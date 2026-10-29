import XCTest
@testable import Juno

@MainActor
final class RemoteImageTests: XCTestCase {
    private func png() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 400, height: 200)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 400, height: 200)) }
    }

    /// A second load is served from memory (no network call), and the picture is downsampled to the requested size.
    func testSecondLoadComesFromMemory() async throws {
        let calls = Counter()
        let data = png()
        let cache = ImageCache(loader: { _ in await calls.bump(); return data })
        let url = URL(string: "https://example.com/a.png")!
        let first = await cache.image(url, maxPixel: 100)
        XCTAssertEqual(max(first?.size.width ?? 0, first?.size.height ?? 0), 100)
        XCTAssertNotNil(cache.cached(url, maxPixel: 100))
        _ = await cache.image(url, maxPixel: 100)
        let count = await calls.value
        XCTAssertEqual(count, 1)
    }

    /// Bytes that decode to no picture read as failure and are not remembered as a picture.
    func testUndecodableDataIsFailureAndNotCached() async {
        let cache = ImageCache(loader: { _ in Data([0, 1, 2, 3, 4, 5, 6, 7]) })
        let url = URL(string: "https://example.com/broken.jpg")!
        let image = await cache.image(url, maxPixel: 128)
        XCTAssertNil(image)
        XCTAssertNil(cache.cached(url, maxPixel: 128))
    }

    /// Two requests at once share one load; a failed load is nil and not remembered.
    func testSharedInflightAndFailure() async {
        let calls = Counter()
        let data = png()
        let cache = ImageCache(loader: { _ in await calls.bump(); try await Task.sleep(for: .milliseconds(50)); return data })
        let url = URL(string: "https://example.com/b.png")!
        async let a = cache.image(url, maxPixel: 128)
        async let b = cache.image(url, maxPixel: 128)
        _ = await (a, b)
        let count = await calls.value
        XCTAssertEqual(count, 1)
        let failing = ImageCache(loader: { _ in throw URLError(.notConnectedToInternet) })
        let none = await failing.image(url, maxPixel: 128)
        XCTAssertNil(none)
        XCTAssertNil(failing.cached(url, maxPixel: 128))
    }
}

private actor Counter {
    var value = 0
    func bump() { value += 1 }
}
