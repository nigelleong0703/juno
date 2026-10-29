import Foundation

// Per-user model providers (BYOK): BACKEND.md §10.14, contracts public-contracts/src/models/model-providers.ts.
// Keys are write-only: they travel in a request body and are never kept; the list only carries `hasKey`.

struct ModelProvider: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    /// builtin | custom | systemone (a typed-decision endpoint, not a chat provider)
    var kind: String
    var providerId: String?
    var baseUrl: String?
    var wire: String?
    /// `systemone` only: the model ids the endpoint offers.
    var models: [String]?
    var hasKey: Bool
    /// apiKey | chatgpt; absent means an API key.
    var auth: String?
    /// connected | reauth_required (ChatGPT only)
    var status: String?
    var accessExpiresAt: Date?

    var isSystemOne: Bool { kind == "systemone" }
    var isChatGPT: Bool { auth == "chatgpt" }
    var needsReauth: Bool { isChatGPT && status == "reauth_required" }
}

struct ModelProviderList: Decodable {
    var providers: [ModelProvider]
    var platformDefault: Bool
    /// An agent can run: the platform default is configured, or one of the owner's providers has a key.
    var usable: Bool
}

struct BuiltinProvider: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var modelCount: Int
}

struct ProviderCatalog: Decodable {
    struct Item: Decodable, Identifiable, Hashable {
        var id: String
        var name: String
        var supportsImages: Bool?
        var reasoningEfforts: [String]?
        /// The one model per provider recommended for background work.
        var cheap: Bool?
    }
    var defaultModel: String?
    var items: [Item]
}

struct ChatGPTLogin: Decodable { var authorizationUrl: String; var loginId: String }

struct BuiltinProviderList: Decodable { var items: [BuiltinProvider] }

/// The account's model choice as `settings.models` stores it.
struct ModelChoice: Equatable {
    var providerId = ""
    var model = ""
}

/// One of the owner's providers and a model it lists, as `settings.models.systemOneModel` stores it.
struct BackgroundChoice: Hashable { var providerId: String; var modelId: String }

/// The model System One decisions would use right now (`providerId` nil is the platform's own endpoint).
/// `source`: chosen | platform | fast-model-emulation.
struct EffectiveModel: Decodable, Hashable { var providerId: String?; var modelId: String; var source: String }

/// The System One model from `GET /v1/settings`: the owner's pick (nil is Auto) and what Auto resolves to.
struct BackgroundModels: Equatable {
    var systemOne: BackgroundChoice?
    var effectiveSystemOne: EffectiveModel?
}

/// The four jobs a model and an effort can be set for (`settings.models.tiers`).
enum TierKey: String, CaseIterable, Identifiable {
    case chat, task, deep, fast
    var id: String { rawValue }
    var title: String {
        switch self {
        case .chat: "Chat"
        case .task: "Tasks"
        case .deep: "Hard problems"
        case .fast: "Quick jobs"
        }
    }
    var blurb: String {
        switch self {
        case .chat: "When you talk to it. Fast replies."
        case .task: "Work it does on its own: sub-tasks, routines, reminders, background jobs."
        case .deep: "When it decides something needs deep thinking."
        case .fast: "Small sub-tasks it decides are simple. Cheaper and faster."
        }
    }
}

/// One row as the owner set it; every field nil is the default. `providerId` nil with a `modelId` is the platform's endpoint.
struct TierChoice: Hashable {
    var providerId: String?
    var modelId: String?
    var effort: String?
    var isDefault: Bool { providerId == nil && modelId == nil && effort == nil }
}

/// What a row runs on right now. `effort` is a level, "none" (no thinking) or nil (the model has none to choose).
struct EffectiveTier: Decodable, Hashable {
    var providerId: String?
    var modelId: String
    var effort: String?
    var source: String
}

/// The four rows from `GET /v1/settings`: the owner's picks and what each resolves to.
struct ModelTiers: Equatable {
    var chosen: [TierKey: TierChoice] = [:]
    var effective: [TierKey: EffectiveTier] = [:]
}
