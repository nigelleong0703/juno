package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AppSettingsResponse
import io.github.nigelleong0703.juno.contract.BuiltinModelProvider
import io.github.nigelleong0703.juno.contract.CompleteChatGPTLoginInput
import io.github.nigelleong0703.juno.contract.CreateModelProviderInput
import io.github.nigelleong0703.juno.contract.ModelCatalog
import io.github.nigelleong0703.juno.contract.ModelProviderList
import io.github.nigelleong0703.juno.contract.SystemOneModelChoice
import io.github.nigelleong0703.juno.contract.TierRow
import io.github.nigelleong0703.juno.contract.UpdateModelProviderInput
import io.github.nigelleong0703.juno.core.Api
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** The sign-in link the server hands out (valid 10 minutes); the user opens it and pastes the address they land on. */
@Serializable data class ChatGptLogin(val authorizationUrl: String, val loginId: String)

/**
 * Model providers and the model settings (iOS State/World+Models.swift). Each function is one endpoint; screens keep the
 * draft and the loaded lists themselves. Clearing a value sends an explicit JSON null, which the server reads as "unset":
 * [JunoJson] would drop a null field, so those bodies are built as [JsonObject].
 */
private fun World.signedInApi(): Api = api ?: throw ApiException.NotSignedIn

suspend fun World.loadModelProviders(): ModelProviderList = signedInApi().get("/v1/model-providers")

suspend fun World.loadBuiltinProviders(): List<BuiltinModelProvider> = signedInApi().list("/v1/model-providers/builtin")

/** Adds a built-in provider by its catalog id, with the user's own API key. */
suspend fun World.addBuiltinProvider(providerId: String, apiKey: String) {
    signedInApi().post("/v1/model-providers", CreateModelProviderInput(kind = "builtin", providerId = providerId, apiKey = apiKey))
}

/** System One is a provider of models the user names, at a base URL they choose. */
suspend fun World.addSystemOneProvider(name: String, baseUrl: String, models: List<String>, apiKey: String) {
    signedInApi().post(
        "/v1/model-providers",
        CreateModelProviderInput(kind = "systemone", name = name, baseUrl = baseUrl, models = models, apiKey = apiKey),
    )
}

/** An OpenAI-compatible endpoint; [wire] is `openai-completions` or `openai-responses`. */
suspend fun World.addCustomProvider(name: String, baseUrl: String, wire: String, apiKey: String) {
    signedInApi().post(
        "/v1/model-providers",
        CreateModelProviderInput(kind = "custom", name = name, baseUrl = baseUrl, wire = wire, apiKey = apiKey),
    )
}

suspend fun World.renameModelProvider(id: String, name: String) {
    signedInApi().patch("/v1/model-providers/$id", UpdateModelProviderInput(name = name))
}

/** Write-only: the new key is sent and never read back. */
suspend fun World.replaceModelProviderKey(id: String, apiKey: String) {
    signedInApi().patch("/v1/model-providers/$id", UpdateModelProviderInput(apiKey = apiKey))
}

suspend fun World.removeModelProvider(id: String) {
    signedInApi().delete("/v1/model-providers/$id")
}

suspend fun World.startChatGptLogin(): ChatGptLogin =
    JunoJson.decodeFromString(signedInApi().post("/v1/model-providers/chatgpt/login"))

suspend fun World.completeChatGptLogin(loginId: String, callbackUrl: String) {
    signedInApi().post("/v1/model-providers/chatgpt/complete", CompleteChatGPTLoginInput(loginId = loginId, callbackUrl = callbackUrl))
}

/** The provider's models, with its default model and each model's capabilities. */
suspend fun World.loadProviderCatalog(providerId: String): ModelCatalog = signedInApi().get("/v1/model-providers/$providerId/models")

/** The key a catalog is stored under for the platform's own endpoint (a tier row without `providerId`). */
const val PLATFORM_KEY = "__platform__"

/** The platform's own models (`GET /v1/models`); only meaningful when `platformDefault` is true. */
suspend fun World.loadPlatformCatalog(): ModelCatalog = signedInApi().get("/v1/models")

/** `GET /v1/settings`: the saved picks plus what Auto resolves to right now. */
suspend fun World.loadModelSettings(): AppSettingsResponse = signedInApi().get("/v1/settings")

/** Saves the default agent model. Nulls clear the field. */
suspend fun World.saveDefaultModel(providerId: String?, model: String?) {
    signedInApi().patch("/v1/settings", buildJsonObject {
        putJsonObject("models") {
            put("providerId", providerId.json())
            put("defaultModel", model.json())
        }
    })
}

/** The System One model (safety judgments). A null choice means Auto. */
suspend fun World.saveSystemOneModel(choice: SystemOneModelChoice?) {
    val value: JsonElement = choice?.let { buildJsonObject { put("providerId", it.providerId.json()); put("modelId", it.modelId.json()) } } ?: JsonNull
    signedInApi().patch("/v1/settings", buildJsonObject { putJsonObject("models") { put("systemOneModel", value) } })
}

/** The jobs a model and an effort can be set for: `models.tiers` keys, in screen order. */
val TIER_KEYS = listOf("chat", "task", "deep", "fast")

/**
 * Saves every tier row at once: the server replaces `tiers` whole. Rows without a model or effort are left out, and no
 * row at all goes out as JSON null (everything back to default).
 */
suspend fun World.saveTiers(rows: Map<String, TierRow>) {
    val kept = TIER_KEYS.mapNotNull { key -> rows[key]?.takeIf { it.providerId != null || it.modelId != null || it.effort != null }?.let { key to it } }
    val value: JsonElement = if (kept.isEmpty()) JsonNull else buildJsonObject {
        kept.forEach { (key, row) ->
            putJsonObject(key) {
                row.providerId?.let { put("providerId", JsonPrimitive(it)) }
                row.modelId?.let { put("modelId", JsonPrimitive(it)) }
                row.effort?.let { put("effort", JsonPrimitive(it)) }
            }
        }
    }
    signedInApi().patch("/v1/settings", buildJsonObject { putJsonObject("models") { put("tiers", value) } })
}

/** `auto` or `juno`. */
suspend fun World.saveWebSearch(mode: String) {
    signedInApi().patch("/v1/settings", buildJsonObject { putJsonObject("models") { put("webSearch", JsonPrimitive(mode)) } })
}

/** An empty string is "unset" in the UI, so it goes out as the same explicit JSON null as a missing value. */
private fun String?.json(): JsonElement = this?.takeIf { it.isNotEmpty() }?.let { JsonPrimitive(it) } ?: JsonNull
