package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.SealedSecureValue
import io.github.nigelleong0703.juno.contract.SecureInputEncryption
import io.github.nigelleong0703.juno.contract.SecureInputField
import io.github.nigelleong0703.juno.contract.SecureInputResult
import io.github.nigelleong0703.juno.contract.SecureVaultEntry
import io.github.nigelleong0703.juno.contract.SecureVaultKeys
import io.github.nigelleong0703.juno.contract.SubmitSecureInput
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.SecureSeal
import io.github.nigelleong0703.juno.core.VaultEntry

/*
 * Secure input (iOS World+Requests.swift, POST /v1/requests/:id/secure-input). Values are sealed on this phone to the
 * computer's key before they reach any call here. Nothing in this file keeps or logs a value.
 */

/**
 * Seals each filled value to the request's key, field by field: [values] are already formatted (see [SecureKind.outputs]).
 * Throws [SecureSeal.OlderComputer] when the request carries no usable key.
 */
fun sealSecureFields(
    fields: List<SecureInputField>,
    values: Map<String, String>,
    encryption: SecureInputEncryption?,
    requestId: String,
): Map<String, SealedSecureValue> {
    val sealed = LinkedHashMap<String, SealedSecureValue>()
    for (field in fields) {
        val value = values[field.id]?.takeIf { it.isNotEmpty() } ?: continue
        sealed[field.id] = SecureSeal.seal(value, encryption, requestId, field.id, field.ref)
    }
    return sealed
}

/** [sealSecureFields] for the request in this world. */
fun World.sealSecureInput(requestId: String, values: Map<String, String>): Map<String, SealedSecureValue> {
    val payload = state.value.request(requestId)?.payload
    return sealSecureFields(payload?.fields.orEmpty(), values, payload?.encryption, requestId)
}

/**
 * Sends the sealed values to the page through the server, and returns each field's result. Throws
 * `ApiException.Api` with 409 `USER_CONTROL` while the user holds the screen, and 409 `ENCRYPTION_UNAVAILABLE` for a
 * request from an older computer. The request is replaced in state from the response when the server sends it.
 */
suspend fun World.submitSecureInput(requestId: String, sealed: Map<String, SealedSecureValue>): List<SecureInputResult.Field> {
    val api = api ?: throw ApiException.NotSignedIn
    val result = JunoJson.decodeFromString<SecureInputResult>(
        api.post("/v1/requests/$requestId/secure-input", SubmitSecureInput(fields = sealed)),
    )
    result.request?.let { fresh ->
        update { s -> s.copy(requests = s.requests.map { if (it.id == fresh.id) fresh else it }) }
    }
    return result.fields.orEmpty()
}

/** Tells the server which vault details exist: names and kinds only, the values stay in this phone's vault. */
fun World.syncVaultKeys(entries: List<VaultEntry>) {
    val body = SecureVaultKeys(entries = entries.map { SecureVaultEntry(it.id, it.label, it.kind) })
    remote { it.put("/v1/secure-vault/keys", body) }
}
