import CoreLocation
import Foundation
import MapKit
import Photos
import UIKit
import Vision

/// What the photo part of the phone needs from the rest of the app: the signed-in upload (`POST /v1/uploads`, the same path as a
/// photo attached to a message). `PhoneDevice` keeps `api` current.
@MainActor final class PhoneUploader {
    var api: API?

    func upload(_ data: Data, name: String, mimeType: String) async throws -> Attachment {
        guard let api else { throw PhoneCallError("Juno is signed out on this iPhone, so the picture could not be uploaded. Nothing was sent.") }
        struct Body: Encodable { var name: String; var mimeType: String; var contentBase64: String }
        let raw = try await api.post("/v1/uploads", Body(name: name, mimeType: mimeType, contentBase64: data.base64EncodedString()))
        struct Envelope: Decodable { var attachment: Attachment }
        if let attachment = try? isoDecoder.decode(Attachment.self, from: raw) { return attachment }
        return try isoDecoder.decode(Envelope.self, from: raw).attachment
    }
}

/// The photo library for the agent (backend BACKEND 7.13b): search by date, place and kind, and send one chosen photo into the chat
/// through the normal upload. Read and add access only through PhotoKit's read/write level; nothing is deleted or edited. When the
/// owner shared only some photos (limited access) only those are searched. Videos are listed but cannot be sent.
@MainActor struct PhotosSystem: PhoneSystem {
    private let service: PhotosService
    private let uploader: PhoneUploader

    init(uploader: PhoneUploader) {
        self.uploader = uploader
        service = PhotosService()
    }

    var access: PhoneAccess {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: .full
        case .limited: .limited
        case .notDetermined: .notAsked
        case .restricted: .unavailable
        default: .denied
        }
    }

    /// The system sheet offers "Select Photos" next to "Allow Full Access": an app cannot ask for the limited kind on its own.
    func request() async { _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite) }
    func actions(for access: PhoneAccess) -> [String] { access.usable ? ["photos.read"] : [] }
    /// A sent photo is remembered by call id, so a delivery that arrives twice uploads once.
    func changes(_ action: String) -> Bool { action == "photos.send" }

    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue {
        switch action {
        case "photos.search": return try await service.search(args, limited: access == .limited)
        case "photos.send":
            let uploader = uploader
            return try await service.send(args) { data, name in try await uploader.upload(data, name: name, mimeType: "image/jpeg") }
        default: throw PhoneCallError("This version of Juno on the iPhone does not know \(action).")
        }
    }

    /// Lets the owner change which photos Juno may see (limited access only; the system ignores it otherwise).
    static func chooseMore() {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        guard let root = scene?.keyWindow?.rootViewController else { return }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top)
    }
}

actor PhotosService {
    /// Photos carrying a labels request: reading a thumbnail and classifying it costs a little each.
    private static let labelled = 12
    private static let scanned = 3000
    private static let longestSide: CGFloat = 2048

    func search(_ args: [String: JSONValue], limited: Bool) async throws -> JSONValue {
        let limit = min(args.int("limit") ?? 10, 20)
        let options = PHFetchOptions()
        var parts: [NSPredicate] = []
        if args["from"] != nil { parts.append(NSPredicate(format: "creationDate >= %@", try PhoneTime.date(args, "from") as NSDate)) }
        if args["to"] != nil { parts.append(NSPredicate(format: "creationDate <= %@", try PhoneTime.end(args, "to") as NSDate)) }
        if args.bool("favoritesOnly") == true { parts.append(NSPredicate(format: "isFavorite == YES")) }
        options.predicate = parts.isEmpty ? nil : NSCompoundPredicate(andPredicateWithSubpredicates: parts)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let center = try await place(args)
        options.fetchLimit = center == nil ? limit : Self.scanned
        let found: PHFetchResult<PHAsset>
        switch args.string("mediaType") ?? "photo" {
        case "video": found = PHAsset.fetchAssets(with: .video, options: options)
        case "any": found = PHAsset.fetchAssets(with: options)
        default: found = PHAsset.fetchAssets(with: .image, options: options)
        }
        let radius = (args.double("nearKm") ?? 10) * 1000
        var assets: [PHAsset] = []
        found.enumerateObjects { asset, _, stop in
            if let center {
                guard let location = asset.location, location.distance(from: center) <= radius else { return }
            }
            assets.append(asset)
            if assets.count >= limit { stop.pointee = true }
        }
        var rows: [JSONValue] = []
        for (index, asset) in assets.enumerated() {
            rows.append(await Self.json(asset, labelled: index < Self.labelled))
        }
        var out: [String: JSONValue] = ["photos": .array(rows)]
        if limited { out["note"] = .string("Juno can see only the photos the owner chose to share, so the library may hold more.") }
        if rows.isEmpty && center != nil { out["hint"] = .string("Nothing taken near that place. Photos without a location are not found by place.") }
        return .object(out)
    }

    /// The place in `args`, looked up on the map; nil when none was asked for.
    private func place(_ args: [String: JSONValue]) async throws -> CLLocation? {
        guard let name = args.string("place") else { return nil }
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = name
        guard let found = try? await MKLocalSearch(request: request).start().mapItems.first else {
            throw PhoneCallError("The map found no place called \"\(name)\". Try a city or a street address, or search without a place.")
        }
        return found.location
    }

    func send(_ args: [String: JSONValue], upload: @Sendable (Data, String) async throws -> Attachment) async throws -> JSONValue {
        let id = try args.requiredString("id")
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            throw PhoneCallError("No photo with that id (it may not be one of the photos the owner shared with Juno). Search again with phone_photos_search.")
        }
        guard asset.mediaType == .image else { throw PhoneCallError("Only photos can be sent, not videos. Nothing was sent.") }
        guard let image = await Self.image(asset, size: CGSize(width: Self.longestSide, height: Self.longestSide), network: true, exact: false),
              let data = image.jpegData(compressionQuality: 0.82) else {
            throw PhoneCallError("The photo could not be read (it may still be in iCloud, or the connection failed). Nothing was sent.")
        }
        let taken = asset.creationDate ?? Date()
        let attachment = try await upload(data, "Photo \(PhoneTime.iso(taken).prefix(10)).jpg")
        return .object([
            "attachment": .object(["id": .string(attachment.id), "name": .string(attachment.name), "mimeType": .string(attachment.mimeType ?? "image/jpeg"), "sizeBytes": .number(Double(attachment.sizeBytes ?? data.count))]),
            "takenAt": .string(PhoneTime.iso(taken)),
        ])
    }

    // MARK: Words and pictures

    private static func json(_ asset: PHAsset, labelled: Bool) async -> JSONValue {
        var out: [String: JSONValue] = [
            "id": .string(asset.localIdentifier), "type": .string(asset.mediaType == .video ? "video" : "photo"),
            "width": .number(Double(asset.pixelWidth)), "height": .number(Double(asset.pixelHeight)), "favorite": .bool(asset.isFavorite),
        ]
        if let date = asset.creationDate { out["date"] = .string(PhoneTime.iso(date)) }
        if asset.mediaType == .video { out["seconds"] = .number(asset.duration.rounded()) }
        if let location = asset.location {
            // Two decimals is about a kilometre: enough to say where, not to find the door.
            out["near"] = .object(["latitude": .number((location.coordinate.latitude * 100).rounded() / 100), "longitude": .number((location.coordinate.longitude * 100).rounded() / 100)])
        }
        if labelled, asset.mediaType == .image, let labels = await labels(asset), !labels.isEmpty { out["labels"] = .array(labels.map(JSONValue.string)) }
        return .object(out)
    }

    /// What is in the picture, worked out on the phone from a small thumbnail (nothing leaves the device).
    private static func labels(_ asset: PHAsset) async -> [String]? {
        guard let thumb = await image(asset, size: CGSize(width: 299, height: 299), network: false, exact: true), let cgImage = thumb.cgImage else { return nil }
        let request = VNClassifyImageRequest()
        guard (try? VNImageRequestHandler(cgImage: cgImage).perform([request])) != nil else { return nil }
        let seen = (request.results ?? []).filter { $0.confidence > 0.3 }.prefix(5)
        return seen.map { $0.identifier.replacingOccurrences(of: "_", with: " ") }
    }

    /// One final image (the system may first hand over a degraded one; those are skipped).
    private static func image(_ asset: PHAsset, size: CGSize, network: Bool, exact: Bool) async -> UIImage? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = network
            options.resizeMode = exact ? .exact : .fast
            options.isSynchronous = false
            PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: options) { image, info in
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                continuation.resume(returning: image)
            }
        }
    }
}
