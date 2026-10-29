package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.contract.ForgetMemoryInput
import io.github.nigelleong0703.juno.contract.MemoryClaim
import io.github.nigelleong0703.juno.contract.MemoryClaimsResult
import io.github.nigelleong0703.juno.contract.MemorySearchHit
import io.github.nigelleong0703.juno.contract.MemorySearchResult
import java.net.URLEncoder

/** GET /v1/memory/claims: what the agents concluded about the user, each with the quote that proves it. */
suspend fun World.memoryClaims(): List<MemoryClaim> {
    val api = api ?: return emptyList()
    return api.get<MemoryClaimsResult>("/v1/memory/claims").claims.orEmpty()
}

/** POST /v1/memory/forget: retracts the claims and removes their lines from the memory files. */
suspend fun World.forgetMemory(claimIds: List<String>) {
    val api = api ?: throw ApiException.NotSignedIn
    api.post("/v1/memory/forget", ForgetMemoryInput(claimIds = claimIds))
    update { it.copy(homeRevision = it.homeRevision + 1) }
}

/** GET /v1/memory/search?q=: ranked chunks of MEMORY.md and the memory and people pages. */
suspend fun World.searchMemory(query: String): List<MemorySearchHit> {
    val api = api ?: return emptyList()
    return api.get<MemorySearchResult>("/v1/memory/search?q=${encodeQuery(query)}").hits.orEmpty()
}

private fun encodeQuery(text: String): String = URLEncoder.encode(text, "UTF-8")

/** Path segments are encoded one by one so the slashes stay (`/v1/home/memory/bank/x.md`). */
internal fun encodePath(path: String): String =
    path.split("/").joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
