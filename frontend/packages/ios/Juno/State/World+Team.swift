import Foundation

/// What Team's People and Memory segments and the Library's Shared filter read. The shapes are the contract's
/// (`Contract.PersonView`, `Contract.MemoryItemView`, public-contracts 0.60.0). A 404 means the route is not there (Coming
/// soon); a 503 means memory is unavailable right now, which the segment shows quietly.
enum TeamLoad<Item> {
    case loading
    case unavailable
    case offline
    case failed
    case loaded([Item])
}

/// A People or Memory write that could not be sent (no connection); the screen puts its optimistic change back.
enum TeamWriteError: Error { case notConnected }

private struct TeamLinkBody: Encodable { var accountId: String }
private struct TeamRenameBody: Encodable { var name: String }
private struct TeamReviewBody: Encodable { var action: String }
private struct TeamSkillIdsBody: Encodable { var skillIds: [String] }

/// `PATCH /v1/memory/items/:id`: only the fields that are sent change; a nil audience keeps a group audience.
private struct TeamMemoryPatch: Encodable {
    var text: String?
    var audience: String?
    var sensitive: Bool?
}

private struct TeamItems<Item: Decodable>: Decodable {
    var items: [Item]
}

private struct SpaceItems: Decodable {
    var items: [Contract.Space]
}

extension World {
    /// GET a Team list: 404 is "not there yet", 503 is "unavailable right now", any other failure is reported as one.
    func teamList<Item: Decodable>(_ path: String, _ type: Item.Type) async -> TeamLoad<Item> {
        guard let api else { return .failed }
        do {
            return .loaded(try await api.get(path, as: TeamItems<Item>.self).items)
        } catch APIError.http(404, _) {
            return .unavailable
        } catch APIError.api(status: 404, code: _, message: _) {
            return .unavailable
        } catch APIError.http(503, _) {
            return .offline
        } catch APIError.api(status: 503, code: _, message: _) {
            return .offline
        } catch {
            return .failed
        }
    }

    /// POST /v1/people/:id/link {accountId}: a suggested account is linked to the person it matches.
    func linkAccount(personId: String, accountId: String) async throws {
        guard let api else { throw TeamWriteError.notConnected }
        _ = try await api.post("/v1/people/\(personId)/link", TeamLinkBody(accountId: accountId))
    }

    /// POST /v1/accounts/:id/unlink: the account is taken off its person.
    func unlinkAccount(_ accountId: String) async throws {
        guard let api else { throw TeamWriteError.notConnected }
        _ = try await api.post("/v1/accounts/\(accountId)/unlink")
    }

    /// PATCH /v1/people/:id {name}.
    func renamePerson(_ personId: String, name: String) async throws {
        guard let api else { throw TeamWriteError.notConnected }
        try await api.patch("/v1/people/\(personId)", TeamRenameBody(name: name))
    }

    /// POST /v1/relations/:id/confirm: the owner confirms a relation the agents inferred.
    func confirmRelation(_ relationId: String) async throws {
        guard let api else { throw TeamWriteError.notConnected }
        _ = try await api.post("/v1/relations/\(relationId)/confirm")
    }

    /// DELETE /v1/relations/:id.
    func deleteRelation(_ relationId: String) async throws {
        guard let api else { throw TeamWriteError.notConnected }
        try await api.delete("/v1/relations/\(relationId)")
    }

    /// PATCH /v1/memory/items/:id. An omitted field keeps its value; an omitted audience keeps a group audience.
    func updateMemoryItem(_ id: String, text: String? = nil, audience: String? = nil, sensitive: Bool? = nil) async throws {
        guard let api else { throw TeamWriteError.notConnected }
        try await api.patch("/v1/memory/items/\(id)", TeamMemoryPatch(text: text, audience: audience, sensitive: sensitive))
    }

    /// DELETE /v1/memory/items/:id: forgotten for good.
    func deleteMemoryItem(_ id: String) async throws {
        guard let api else { throw TeamWriteError.notConnected }
        try await api.delete("/v1/memory/items/\(id)")
    }

    /// POST /v1/memory/review/:id: keep the item, or delete it (`action` is "keep" or "delete").
    func resolveMemoryReview(_ id: String, action: String) async throws {
        guard let api else { throw TeamWriteError.notConnected }
        _ = try await api.post("/v1/memory/review/\(id)", TeamReviewBody(action: action))
    }

    /// Discover's "Add": PATCH /v1/agents/:id {skillIds} with the skill added to the agent's own list (its other skills stay).
    func addSkill(_ skillId: String, toAgent agentId: String) async throws {
        guard let api, let agent = agent(agentId) else { throw TeamWriteError.notConnected }
        var skillIds = agent.skillIds ?? []
        if !skillIds.contains(skillId) { skillIds.append(skillId) }
        try await api.patch("/v1/agents/\(agentId)", TeamSkillIdsBody(skillIds: skillIds))
        if let i = agents.firstIndex(where: { $0.id == agentId }) { agents[i].skillIds = skillIds }
    }

    // MARK: Skill versions (the detail view; the server answers refusals as `APIError.api` with a stable code)

    /// PUT /v1/skills/:id: the text becomes a new active version. An edit replaces the deps it is sent with, so the current
    /// ones go back as they are.
    func updateSkill(_ skill: Skill, name: String, description: String, instructions: String) async throws -> Skill {
        guard let api else { throw TeamWriteError.notConnected }
        let deps = (skill.active?.deps ?? []).map { Contract.SkillDepInput(type: $0.type, name: $0.name, catalogId: $0.catalogId) }
        let body = Contract.UpdateSkillInput(name: name, description: description, instructions: instructions, deps: deps)
        let updated = try isoDecoder.decode(Skill.self, from: try await api.put("/v1/skills/\(skill.id)", body))
        replaceSkill(updated)
        return updated
    }

    /// GET /v1/skills/:id/versions: newest first.
    func skillVersions(_ skillId: String) async throws -> [SkillVersion] {
        guard let api else { throw TeamWriteError.notConnected }
        return try await api.list("/v1/skills/\(skillId)/versions", as: SkillVersion.self)
    }

    /// POST /v1/skills/:id/versions/:v/activate: turns a version on ("Turn on" after a tool the skill uses changed).
    func activateSkillVersion(_ skillId: String, version: Int) async throws -> Skill {
        guard let api else { throw TeamWriteError.notConnected }
        let updated = try await api.post("/v1/skills/\(skillId)/versions/\(version)/activate", nil, as: Skill.self)
        replaceSkill(updated)
        return updated
    }

    /// POST /v1/skills/:id/rollback: the pointer moves to the previous version (409 when there is none).
    func rollbackSkill(_ skillId: String) async throws -> Skill {
        guard let api else { throw TeamWriteError.notConnected }
        let updated = try await api.post("/v1/skills/\(skillId)/rollback", nil, as: Skill.self)
        replaceSkill(updated)
        return updated
    }

    private func replaceSkill(_ skill: Skill) {
        if let i = skills.firstIndex(where: { $0.id == skill.id }) { skills[i] = skill }
    }

    /// GET /v1/spaces into `spaces`; the Library's Shared filter lists the ones with a hosted link.
    func loadSpaces() async {
        guard let api else { return }
        if let list = try? await api.get("/v1/spaces", as: SpaceItems.self) { spaces = list.items }
    }
}
