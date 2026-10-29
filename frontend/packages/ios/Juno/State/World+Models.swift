import Foundation

/// Settings → Models: every request about model providers and the account's model choice goes through here, so
/// screens keep only their drafts and the provider list behind the setup notice stays current after each change.
extension World {
    /// Reloads the provider list behind the setup notice; a failure keeps what was known.
    @MainActor
    func refreshModelProviders() async {
        guard let api else { modelProviders = nil; return }
        if let list = try? await api.get("/v1/model-providers", as: ModelProviderList.self) { modelProviders = list }
    }

    /// The account's default agent: the one in its first direct chat.
    var defaultDirectChat: Conversation? { conversations.first { $0.kind == "direct" } }

    func builtinProviders() async throws -> [BuiltinProvider] {
        try await signedIn().get("/v1/model-providers/builtin", as: BuiltinProviderList.self).items
    }

    /// Adds a built-in provider (`builtin` set), a System One endpoint (`systemOneModels` set) or a custom
    /// OpenAI-compatible endpoint. The key is not kept.
    @MainActor
    func addModelProvider(builtin: BuiltinProvider?, name: String, baseUrl: String, wire: String, apiKey: String,
                          systemOneModels: [String]? = nil) async throws {
        struct Body: Encodable {
            var kind: String, apiKey: String
            var providerId: String?, name: String?, baseUrl: String?, wire: String?, models: [String]?
        }
        let body: Body = if let builtin {
            Body(kind: "builtin", apiKey: apiKey, providerId: builtin.id)
        } else if let systemOneModels {
            Body(kind: "systemone", apiKey: apiKey, name: name, baseUrl: baseUrl, models: systemOneModels)
        } else {
            Body(kind: "custom", apiKey: apiKey, name: name, baseUrl: baseUrl, wire: wire)
        }
        try await signedIn().post("/v1/model-providers", body)
        await refreshModelProviders()
    }

    @MainActor
    func renameModelProvider(_ id: String, to name: String) async throws {
        defer { Task { await refreshModelProviders() } }
        try await signedIn().patch("/v1/model-providers/\(id)", ["name": name])
    }

    @MainActor
    func replaceModelProviderKey(_ id: String, apiKey: String) async throws {
        try await signedIn().patch("/v1/model-providers/\(id)", ["apiKey": apiKey])
        await refreshModelProviders()
    }

    @MainActor
    func removeModelProvider(_ id: String) async throws {
        defer { Task { await refreshModelProviders() } }
        try await signedIn().delete("/v1/model-providers/\(id)")
    }

    func startChatGPTLogin() async throws -> ChatGPTLogin {
        try isoDecoder.decode(ChatGPTLogin.self, from: try await signedIn().post("/v1/model-providers/chatgpt/login"))
    }

    @MainActor
    func completeChatGPTLogin(loginId: String, callbackUrl: String) async throws {
        struct Body: Encodable { var loginId: String; var callbackUrl: String }
        try await signedIn().post("/v1/model-providers/chatgpt/complete", Body(loginId: loginId, callbackUrl: callbackUrl))
        await refreshModelProviders()
    }

    func providerCatalog(_ id: String) async throws -> ProviderCatalog {
        try await signedIn().get("/v1/model-providers/\(id)/models", as: ProviderCatalog.self)
    }

    /// The platform's own models (`GET /v1/models`); only meaningful when `platformDefault` is true.
    func platformCatalog() async throws -> ProviderCatalog {
        try await signedIn().get("/v1/models", as: ProviderCatalog.self)
    }

    /// The saved choice, or nil when settings can't be read.
    func savedModelChoice() async -> ModelChoice? {
        struct Remote: Decodable { struct Models: Decodable { var providerId: String?; var defaultModel: String? }; var models: Models? }
        guard let api, let remote = try? await api.get("/v1/settings", as: Remote.self) else { return nil }
        return ModelChoice(providerId: remote.models?.providerId ?? "", model: remote.models?.defaultModel ?? "")
    }

    /// Saves the choice; empty fields are sent as JSON null so the server clears them.
    func saveModelChoice(_ choice: ModelChoice) async throws {
        struct Patch: Encodable {
            var providerId: String?, defaultModel: String?
            func encode(to encoder: Encoder) throws {
                var root = encoder.container(keyedBy: K.self)
                var m = root.nestedContainer(keyedBy: K.self, forKey: .models)
                // JSON null clears a field; leaving it out would keep the old value.
                if let providerId { try m.encode(providerId, forKey: .providerId) } else { try m.encodeNil(forKey: .providerId) }
                if let defaultModel { try m.encode(defaultModel, forKey: .defaultModel) } else { try m.encodeNil(forKey: .defaultModel) }
            }
            enum K: String, CodingKey { case models, providerId, defaultModel }
        }
        let empty = choice.providerId.isEmpty
        try await signedIn().patch("/v1/settings", Patch(providerId: empty ? nil : choice.providerId,
                                                         defaultModel: empty ? nil : choice.model))
    }

    /// How agents search the web: `auto` (the model's own search when it has one) or `juno` (always Juno's). Nil when settings can't be read.
    func savedWebSearch() async -> String? {
        struct Remote: Decodable { struct Models: Decodable { var webSearch: String? }; var models: Models? }
        guard let api, let remote = try? await api.get("/v1/settings", as: Remote.self) else { return nil }
        return remote.models?.webSearch ?? "auto"
    }

    func saveWebSearch(_ mode: String) async throws {
        struct Patch: Encodable { struct Models: Encodable { var webSearch: String }; var models: Models }
        try await signedIn().patch("/v1/settings", Patch(models: .init(webSearch: mode)))
    }

    /// The System One model: the owner's pick and what Auto resolves to. Nil when settings can't be read.
    func backgroundModels() async -> BackgroundModels? {
        struct Remote: Decodable {
            struct Choice: Decodable { var providerId: String; var modelId: String }
            struct Models: Decodable { var systemOneModel: Choice? }
            var models: Models?
            var effectiveSystemOneModel: EffectiveModel?
        }
        guard let api, let remote = try? await api.get("/v1/settings", as: Remote.self) else { return nil }
        let pick = remote.models?.systemOneModel.map { BackgroundChoice(providerId: $0.providerId, modelId: $0.modelId) }
        return BackgroundModels(systemOne: pick, effectiveSystemOne: remote.effectiveSystemOneModel)
    }

    /// Saves the System One model; nil is sent as JSON null so the server goes back to Auto.
    func saveSystemOneModel(_ choice: BackgroundChoice?) async throws {
        struct Patch: Encodable {
            var choice: BackgroundChoice?
            enum K: String, CodingKey { case models, systemOneModel, providerId, modelId }
            func encode(to encoder: Encoder) throws {
                var root = encoder.container(keyedBy: K.self)
                var models = root.nestedContainer(keyedBy: K.self, forKey: .models)
                guard let choice else { try models.encodeNil(forKey: .systemOneModel); return }
                var one = models.nestedContainer(keyedBy: K.self, forKey: .systemOneModel)
                try one.encode(choice.providerId, forKey: .providerId)
                try one.encode(choice.modelId, forKey: .modelId)
            }
        }
        try await signedIn().patch("/v1/settings", Patch(choice: choice))
    }

    /// The four tier rows: the owner's picks and what each runs on now. Nil when settings can't be read.
    func modelTiers() async -> ModelTiers? {
        struct Row: Decodable { var providerId: String?; var modelId: String?; var effort: String? }
        struct Remote: Decodable {
            struct Models: Decodable { var tiers: [String: Row]? }
            var models: Models?
            var effectiveTiers: [String: EffectiveTier?]?
        }
        guard let api, let remote = try? await api.get("/v1/settings", as: Remote.self) else { return nil }
        var out = ModelTiers()
        for key in TierKey.allCases {
            if let row = remote.models?.tiers?[key.rawValue] {
                let choice = TierChoice(providerId: row.providerId, modelId: row.modelId, effort: row.effort)
                if !choice.isDefault { out.chosen[key] = choice }
            }
            if let effective = remote.effectiveTiers?[key.rawValue], let effective { out.effective[key] = effective }
        }
        return out
    }

    /// Saves every tier row at once (the server replaces `tiers` whole). Rows left at the default are not sent; none at all sends null.
    func saveTiers(_ chosen: [TierKey: TierChoice]) async throws {
        struct Patch: Encodable {
            var chosen: [TierKey: TierChoice]
            enum K: String, CodingKey { case models, tiers, providerId, modelId, effort }
            struct Row: CodingKey {
                var stringValue: String; var intValue: Int? { nil }
                init(_ s: String) { stringValue = s }
                init?(stringValue: String) { self.stringValue = stringValue }
                init?(intValue: Int) { nil }
            }
            func encode(to encoder: Encoder) throws {
                var root = encoder.container(keyedBy: K.self)
                var models = root.nestedContainer(keyedBy: K.self, forKey: .models)
                let rows = TierKey.allCases.compactMap { key in chosen[key].flatMap { $0.isDefault ? nil : (key, $0) } }
                if rows.isEmpty { try models.encodeNil(forKey: .tiers); return }
                var tiers = models.nestedContainer(keyedBy: Row.self, forKey: .tiers)
                for (key, row) in rows {
                    var one = tiers.nestedContainer(keyedBy: K.self, forKey: Row(key.rawValue))
                    if let id = row.providerId { try one.encode(id, forKey: .providerId) }
                    if let id = row.modelId { try one.encode(id, forKey: .modelId) }
                    if let effort = row.effort { try one.encode(effort, forKey: .effort) }
                }
            }
        }
        try await signedIn().patch("/v1/settings", Patch(chosen: chosen))
    }

    private func signedIn() throws -> API {
        guard let api else { throw APIError.notSignedIn }
        return api
    }
}
