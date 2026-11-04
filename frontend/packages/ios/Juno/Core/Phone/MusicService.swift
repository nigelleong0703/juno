import Foundation
import MediaPlayer
import MusicKit

/// Music for the agent (backend BACKEND 7.13b): what is playing, play something, pause / resume / skip. It drives the system music
/// player, so the Music app plays and keeps playing when Juno is closed. Playing from the Apple Music catalog needs the owner's
/// subscription and the MusicKit App Service on the app's identifier (a paid developer account); when MusicKit says it isn't set up,
/// play falls back to the owner's own library (MediaPlayer). What is playing and pause / skip go through
/// `MPMusicPlayerController.systemMusicPlayer`, which is the same Music app state and needs no developer token.
@MainActor struct MusicSystem: PhoneSystem {
    private let service = MusicService()

    /// Either permission is enough: both are the "Media & Apple Music" switch in the iPhone's settings for Juno.
    var access: PhoneAccess {
        if MusicAuthorization.currentStatus == .authorized || MPMediaLibrary.authorizationStatus() == .authorized { return .full }
        switch (MusicAuthorization.currentStatus, MPMediaLibrary.authorizationStatus()) {
        case (.notDetermined, _), (_, .notDetermined): return .notAsked
        case (.restricted, _), (_, .restricted): return .unavailable
        default: return .denied
        }
    }

    func request() async {
        _ = await MusicAuthorization.request()
        if MPMediaLibrary.authorizationStatus() == .notDetermined {
            _ = await withCheckedContinuation { (continuation: CheckedContinuation<MPMediaLibraryAuthorizationStatus, Never>) in
                MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
            }
        }
    }

    func actions(for access: PhoneAccess) -> [String] { access.usable ? ["music.read", "music.control"] : [] }
    func changes(_ action: String) -> Bool { action == "music.play" || action == "music.transport" }

    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue {
        // A permission prompt would take the app out of the foreground, which withdraws the phone's declaration and loses the call,
        // so a call never asks: the switch in Settings > iPhone access does.
        guard access.usable else { throw PhoneCallError("Needs permission on the iPhone: the owner opens Juno > Settings > iPhone access and allows Music (or iPhone Settings > Juno > Media & Apple Music). Nothing was played.") }
        switch action {
        case "music.now_playing": return await service.nowPlaying()
        case "music.play": return try await service.play(args)
        case "music.transport": return try await service.transport(args)
        default: throw PhoneCallError("This version of Juno on the iPhone does not know \(action).")
        }
    }
}

actor MusicService {
    func nowPlaying() async -> JSONValue {
        await MainActor.run {
            let player = MPMusicPlayerController.systemMusicPlayer
            let status: String
            switch player.playbackState {
            case .playing: status = "playing"
            case .paused: status = "paused"
            case .stopped: status = "stopped"
            default: status = "other"
            }
            var out: [String: JSONValue] = ["status": .string(status)]
            if let item = player.nowPlayingItem {
                if let title = item.title { out["title"] = .string(title) }
                if let artist = item.artist { out["artist"] = .string(artist) }
            } else {
                out["note"] = .string("Nothing is in the queue.")
            }
            return .object(out)
        }
    }

    func play(_ args: [String: JSONValue]) async throws -> JSONValue {
        let query = try args.requiredString("query")
        let kind = args.string("kind") ?? "song"
        // The catalog only when MusicKit is allowed to talk to Apple Music; otherwise (or when it isn't set up) the owner's library.
        if MusicAuthorization.currentStatus == .authorized {
            do { return try await playFromCatalog(query, kind) }
            catch let error as MusicTokenRequestError where error == .developerTokenRequestFailed {}
        }
        return try await playFromLibrary(query, kind)
    }

    private func playFromCatalog(_ query: String, _ kind: String) async throws -> JSONValue {
        let player = SystemMusicPlayer.shared
        guard try await MusicSubscription.current.canPlayCatalogContent else {
            throw PhoneCallError("The owner has no Apple Music subscription on this iPhone, so nothing can be played from Apple Music. Nothing was played.")
        }
        switch kind {
        case "album":
            let response = try await MusicCatalogSearchRequest(term: query, types: [Album.self]).response()
            guard let album = response.albums.first else { throw Self.notFound(query) }
            player.queue = [album]
            try await player.play()
            return .object(["playing": .string(album.title), "artist": .string(album.artistName), "kind": .string("album")])
        case "playlist":
            let response = try await MusicCatalogSearchRequest(term: query, types: [Playlist.self]).response()
            guard let playlist = response.playlists.first else { throw Self.notFound(query) }
            player.queue = [playlist]
            try await player.play()
            return .object(["playing": .string(playlist.name), "kind": .string("playlist")])
        default:
            let response = try await MusicCatalogSearchRequest(term: query, types: [Song.self]).response()
            guard let song = response.songs.first else { throw Self.notFound(query) }
            player.queue = [song]
            try await player.play()
            return .object(["playing": .string(song.title), "artist": .string(song.artistName), "kind": .string("song")])
        }
    }

    private static func notFound(_ query: String) -> PhoneCallError {
        PhoneCallError("Apple Music found nothing for \"\(query)\". Try the title with the artist's name. Nothing was played.")
    }

    /// The owner's own library: every word of the query must appear (case-insensitive) in the title, artist or album; the shortest
    /// title among the matches wins, so "Neon" picks the song "Neon" over "Neon Lights (Live)".
    private func playFromLibrary(_ query: String, _ kind: String) async throws -> JSONValue {
        guard MPMediaLibrary.authorizationStatus() == .authorized else {
            throw PhoneCallError("Needs permission on the iPhone: the owner opens Juno > Settings > iPhone access and allows Music (iPhone Settings > Juno > Media & Apple Music). Nothing was played.")
        }
        let words = query.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        return try await MainActor.run {
            func matches(_ text: String) -> Bool { words.allSatisfy { text.localizedCaseInsensitiveContains($0) } }
            var chosen: (collection: MPMediaItemCollection, name: String, artist: String?)?
            func consider(_ collection: MPMediaItemCollection, name: String?, haystack: String, artist: String?) {
                guard let name, matches(haystack) else { return }
                if chosen == nil || name.count < chosen!.name.count { chosen = (collection, name, artist) }
            }
            switch kind {
            case "album":
                for album in MPMediaQuery.albums().collections ?? [] {
                    let item = album.representativeItem
                    consider(album, name: item?.albumTitle, haystack: "\(item?.albumTitle ?? "") \(item?.albumArtist ?? "")", artist: item?.albumArtist)
                }
            case "playlist":
                for playlist in (MPMediaQuery.playlists().collections ?? []).compactMap({ $0 as? MPMediaPlaylist }) {
                    consider(playlist, name: playlist.name, haystack: playlist.name ?? "", artist: nil)
                }
            default:
                for song in MPMediaQuery.songs().items ?? [] {
                    consider(MPMediaItemCollection(items: [song]), name: song.title, haystack: "\(song.title ?? "") \(song.artist ?? "") \(song.albumTitle ?? "")", artist: song.artist)
                }
            }
            guard let found = chosen else {
                throw PhoneCallError("\"\(query)\" is not in the owner's music library, and searching the Apple Music catalog isn't available in this build of Juno. Nothing was played and nothing was opened. Say so, and ask for a title that is in their library.")
            }
            let player = MPMusicPlayerController.systemMusicPlayer
            player.setQueue(with: found.collection)
            player.play()
            var out: [String: JSONValue] = ["playing": .string(found.name), "kind": .string(kind), "source": .string("your library")]
            if let artist = found.artist { out["artist"] = .string(artist) }
            return .object(out)
        }
    }

    func transport(_ args: [String: JSONValue]) async throws -> JSONValue {
        let action = try args.requiredString("action")
        try await MainActor.run {
            let player = MPMusicPlayerController.systemMusicPlayer
            switch action {
            case "pause": player.pause()
            case "resume": player.play()
            case "next": player.skipToNextItem()
            case "previous": player.skipToPreviousItem()
            default: throw PhoneCallError("`action` must be pause, resume, next or previous.")
            }
        }
        return await nowPlaying()
    }
}
