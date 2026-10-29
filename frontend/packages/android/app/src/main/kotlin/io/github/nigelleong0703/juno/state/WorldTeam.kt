package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.LinkAccountInput
import io.github.nigelleong0703.juno.contract.RenamePersonInput
import io.github.nigelleong0703.juno.contract.ReviewMemoryItemInput
import io.github.nigelleong0703.juno.contract.Space
import io.github.nigelleong0703.juno.contract.UpdateMemoryItemInput
import io.github.nigelleong0703.juno.core.Api
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.nav.Route

/** The Team tab's segments, in order (owner-approved 2026-10-26). */
enum class TeamSegment { Agents, People, Memory }

/**
 * What a Team list shows: the route answered, or why it did not (iOS `TeamLoad`). 404 means the route is not there yet
 * ("Coming soon"); 503 means memory is unavailable right now, which the list shows quietly.
 */
sealed interface TeamLoad<out T> {
    data object Loading : TeamLoad<Nothing>
    data object Unavailable : TeamLoad<Nothing>
    data object Offline : TeamLoad<Nothing>
    data object Failed : TeamLoad<Nothing>
    data class Loaded<T>(val items: List<T>) : TeamLoad<T>
}

/** The HTTP status behind a refused request, when it has one. */
internal fun ApiException.httpStatus(): Int? = when (this) {
    is ApiException.Http -> status
    is ApiException.Api -> status
    else -> null
}

/** GET a Team list (`{items: [...]}`): 404 is "not there yet", 503 is "unavailable right now", any other failure is one state. */
internal suspend inline fun <reified T> World.teamList(path: String): TeamLoad<T> {
    val api = api ?: return TeamLoad.Failed
    return try {
        TeamLoad.Loaded(api.list<T>(path))
    } catch (e: Throwable) {
        if (e.isCancellation) throw e
        when ((e as? ApiException)?.httpStatus()) {
            404 -> TeamLoad.Unavailable
            503 -> TeamLoad.Offline
            else -> TeamLoad.Failed
        }
    }
}

/**
 * A Team write: [work] runs with the signed-in API. A failure lands in the sync alert, as every other write does (iOS
 * `try?` shows nothing, the Android app says why). True when it went through, so the caller reads the list again.
 */
suspend fun World.teamWrite(work: suspend (Api) -> Unit): Boolean {
    val api = api ?: return false
    return try {
        work(api)
        true
    } catch (e: Throwable) {
        if (!e.isCancellation) update { it.copy(syncError = e.userMessage) }
        false
    }
}

/** GET /v1/spaces into [WorldState.spaces]; the Library's Shared filter lists the ones with a hosted link. */
suspend fun World.loadSpaces() {
    val api = api ?: return
    val list = runCatching { api.list<Space>("/v1/spaces") }.getOrNull() ?: return
    update { it.copy(spaces = list) }
}

/** Opens the Team tab on [segment] (Today's memory and possible-match rows). */
fun World.openTeam(segment: TeamSegment) {
    update { it.copy(teamSegment = segment) }
    open(Route.Team)
}

/** The segment the owner picked on Team. */
fun World.setTeamSegment(segment: TeamSegment) = update { it.copy(teamSegment = segment) }

// --- People (GET /v1/people; the contract's 0.60.0 routes) ---

/** POST /v1/people/:id/link: the owner confirms a suggested account belongs to this person. */
suspend fun World.linkAccount(personId: String, accountId: String): Boolean =
    teamWrite { it.post("/v1/people/$personId/link", LinkAccountInput(accountId = accountId)) }

/** POST /v1/accounts/:id/unlink: the account stops being part of its person. */
suspend fun World.unlinkAccount(accountId: String): Boolean =
    teamWrite { it.post("/v1/accounts/$accountId/unlink") }

/** PATCH /v1/people/:id: the name the agents use for the person. */
suspend fun World.renamePerson(personId: String, name: String): Boolean =
    teamWrite { it.patch("/v1/people/$personId", RenamePersonInput(name = name)) }

/** POST /v1/relations/:id/confirm: the owner agrees the relation is right. */
suspend fun World.confirmRelation(relationId: String): Boolean =
    teamWrite { it.post("/v1/relations/$relationId/confirm") }

/** DELETE /v1/relations/:id: the relation between two people is removed. */
suspend fun World.deleteRelation(relationId: String): Boolean =
    teamWrite { it.delete("/v1/relations/$relationId") }

// --- Memory (GET /v1/memory/items, /v1/memory/review) ---

/** PATCH /v1/memory/items/:id: the text, who it is shared with, and whether it is sensitive. */
suspend fun World.updateMemoryItem(id: String, text: String, audience: String, sensitive: Boolean): Boolean =
    teamWrite { it.patch("/v1/memory/items/$id", UpdateMemoryItemInput(text = text, audience = audience, sensitive = sensitive)) }

/** DELETE /v1/memory/items/:id: "Forget" removes the item for good. */
suspend fun World.deleteMemoryItem(id: String): Boolean =
    teamWrite { it.delete("/v1/memory/items/$id") }

/** POST /v1/memory/review/:id: keep the item the review queue holds, or delete it. */
suspend fun World.resolveMemoryReview(id: String, keep: Boolean): Boolean =
    teamWrite {
        val action = if (keep) ReviewMemoryItemInput.ActionValue.keep else ReviewMemoryItemInput.ActionValue.delete
        it.post("/v1/memory/review/$id", ReviewMemoryItemInput(action = action))
    }
