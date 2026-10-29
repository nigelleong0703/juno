import Foundation
import Observation

/// What Team's Memory and People screens (the lists and their detail pages) share, so a change made on a detail page shows in
/// the list under it. Every change shows at once and is put back if the server refuses it; a successful change reloads from
/// the server. The calls themselves are in `World+Team`.
@MainActor
@Observable
final class TeamMemoryStore {
    /// Every item (the first page the server sends): what the search looks through and what an item's page reads.
    var load: TeamLoad<Contract.MemoryItemView> = .loading
    /// The topic cards (`GET /v1/memory/topics`), in the order the server sends them.
    var topicLoad: TeamLoad<Contract.MemoryTopicView> = .loading
    /// One topic's items (`GET /v1/memory/items?topic=`), loaded with the topics: the prose names them and its phrases open them.
    var topicItems: [String: TeamLoad<Contract.MemoryItemView>] = [:]
    /// Items waiting for the owner's keep-or-delete.
    var review: [Contract.MemoryItemView] = []
    /// The last change was refused (and put back).
    var refused = false

    var items: [Contract.MemoryItemView] {
        if case .loaded(let items) = load { return items }
        return []
    }

    var topics: [Contract.MemoryTopicView] {
        if case .loaded(let topics) = topicLoad { return topics }
        return []
    }

    /// The items of one topic, in the states a list has.
    func items(in topic: String) -> TeamLoad<Contract.MemoryItemView> { topicItems[topic] ?? .loading }

    func item(_ id: String) -> Contract.MemoryItemView? {
        items.first { $0.id == id } ?? review.first { $0.id == id }
            ?? topicItems.values.lazy.compactMap { load -> Contract.MemoryItemView? in
                if case .loaded(let list) = load { return list.first { $0.id == id } }
                return nil
            }.first
    }

    func reload(_ world: World) async {
        load = await world.teamList("/v1/memory/items", Contract.MemoryItemView.self)
        topicLoad = await world.teamList("/v1/memory/topics", Contract.MemoryTopicView.self)
        // Every topic's items, side by side: a phrase in the topic's prose opens one of them.
        if case .loaded(let cards) = topicLoad {
            let loads = cards.map { card in Task { await loadTopic(world, card.topic ?? "other") } }
            for load in loads { await load.value }
        }
        if case .loaded(let waiting) = await world.teamList("/v1/memory/review", Contract.MemoryItemView.self) {
            review = waiting
        }
    }

    func loadTopic(_ world: World, _ topic: String) async {
        topicItems[topic] = await world.teamList("/v1/memory/items?topic=\(topic)", Contract.MemoryItemView.self)
    }

    /// Shows `change` on every list that holds the item at once, makes the server call, and reloads on success; on a refusal the
    /// lists go back as they were.
    private func optimistic(_ world: World, _ change: @escaping ([Contract.MemoryItemView]) -> [Contract.MemoryItemView], _ work: @escaping () async throws -> Void) {
        let previous = (load, topicItems)
        if case .loaded(let all) = load { load = .loaded(change(all)) }
        for (topic, list) in topicItems {
            if case .loaded(let rows) = list { topicItems[topic] = .loaded(change(rows)) }
        }
        refused = false
        Task {
            do {
                try await work()
                await reload(world)
            } catch {
                (load, topicItems) = previous
                refused = true
            }
        }
    }

    func setSensitive(_ world: World, _ item: Contract.MemoryItemView, _ sensitive: Bool) {
        optimistic(world, { rows in
            rows.map { candidate in
                guard candidate.id == item.id else { return candidate }
                var copy = candidate
                copy.sensitive = sensitive
                return copy
            }
        }) { try await world.updateMemoryItem(item.id, sensitive: sensitive) }
    }

    /// Sends only the fields that changed. `audience` is nil to keep a group audience.
    func edit(_ world: World, _ item: Contract.MemoryItemView, text: String?, audience: String?, sensitive: Bool?) {
        optimistic(world, { rows in
            rows.map { candidate in
                guard candidate.id == item.id else { return candidate }
                var copy = candidate
                if let text { copy.text = text }
                if let sensitive { copy.sensitive = sensitive }
                if let audience { copy.audience = Contract.MemoryItemView.Audience(kind: audience, label: copy.audience?.label) }
                return copy
            }
        }) { try await world.updateMemoryItem(item.id, text: text, audience: audience, sensitive: sensitive) }
    }

    func forget(_ world: World, _ item: Contract.MemoryItemView) {
        optimistic(world, { rows in rows.filter { $0.id != item.id } }) { try await world.deleteMemoryItem(item.id) }
    }

    /// Keep leaves the item in memory and out of the queue; delete removes it. The queue shows the change at once.
    func resolveReview(_ world: World, _ item: Contract.MemoryItemView, action: String) {
        let previousReview = review
        review.removeAll { $0.id == item.id }
        refused = false
        Task {
            do {
                try await world.resolveMemoryReview(item.id, action: action)
                await reload(world)
            } catch {
                review = previousReview
                refused = true
            }
        }
    }
}

@MainActor
@Observable
final class TeamPeopleStore {
    var load: TeamLoad<Contract.PersonView> = .loading
    var matches: [Contract.PossibleMatch] = []
    var refused = false

    var people: [Contract.PersonView] {
        if case .loaded(let items) = load { return items }
        return []
    }

    func person(_ id: String) -> Contract.PersonView? { people.first { $0.id == id } }
    var owner: Contract.PersonView? { people.first { $0.isOwner == true } }

    func reload(_ world: World) async {
        load = await world.teamList("/v1/people", Contract.PersonView.self)
        if case .loaded(let items) = await world.teamList("/v1/people/possible-matches", Contract.PossibleMatch.self) {
            matches = items
        }
    }

    private func optimistic(_ world: World, _ next: [Contract.PersonView], _ work: @escaping () async throws -> Void) {
        let previous = people
        load = .loaded(next)
        refused = false
        Task {
            do {
                try await work()
                await reload(world)
            } catch {
                load = .loaded(previous)
                refused = true
            }
        }
    }

    private func change(_ person: Contract.PersonView, _ edit: (inout Contract.PersonView) -> Void) -> [Contract.PersonView] {
        people.map { candidate in
            guard candidate.id == person.id else { return candidate }
            var copy = candidate
            edit(&copy)
            return copy
        }
    }

    func unlink(_ world: World, _ account: Contract.AccountView, of person: Contract.PersonView) {
        let next = change(person) { $0.accounts = ($0.accounts ?? []).filter { $0.id != account.id } }
        optimistic(world, next) { try await world.unlinkAccount(account.id) }
    }

    func rename(_ world: World, _ person: Contract.PersonView, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != person.name else { return }
        optimistic(world, change(person) { $0.name = trimmed }) { try await world.renamePerson(person.id, name: trimmed) }
    }

    func confirm(_ world: World, _ relation: Contract.PersonRelationView, of person: Contract.PersonView) {
        let next = change(person) { copy in
            copy.relations = (copy.relations ?? []).map { item in
                var changed = item
                if item.id == relation.id { changed.confirmed = true }
                return changed
            }
        }
        optimistic(world, next) { try await world.confirmRelation(relation.id) }
    }

    func remove(_ world: World, _ relation: Contract.PersonRelationView, of person: Contract.PersonView) {
        let next = change(person) { $0.relations = ($0.relations ?? []).filter { $0.id != relation.id } }
        optimistic(world, next) { try await world.deleteRelation(relation.id) }
    }

    /// Links a suggested account to the person it matches: the match leaves the list at once, and comes back if refused.
    func link(_ world: World, _ match: Contract.PossibleMatch) {
        guard let accountId = match.account?.id, let personId = match.person?.id else { return }
        let previous = matches
        matches.removeAll { $0.account?.id == accountId && $0.person?.id == personId }
        refused = false
        Task {
            do {
                try await world.linkAccount(personId: personId, accountId: accountId)
                await reload(world)
            } catch {
                matches = previous
                refused = true
            }
        }
    }
}
