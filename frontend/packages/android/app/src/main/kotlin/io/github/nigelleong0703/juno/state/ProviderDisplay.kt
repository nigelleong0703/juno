package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.ModelProvider
import java.net.URI

/**
 * What a provider row says and what a provider form accepts (iOS ModelSettings.swift:113-139, 212, 318-331, and
 * BackgroundModels.swift:17). Pure, so the rules are unit-tested rather than left to a screen.
 */
object ProviderDisplay {
    /** Built-in ids shown first in "Popular", in this order (ModelSettings.swift:212). */
    val popular = listOf("openai", "anthropic", "openrouter", "google", "deepseek", "opencode-go")

    fun isSystemOne(p: ModelProvider): Boolean = p.kind == ModelProvider.KindValue.systemone

    fun isChatGpt(p: ModelProvider): Boolean = p.auth == ModelProvider.AuthValue.chatgpt

    /** A provider that can be a default: signed in (ChatGPT) or holding a key. */
    fun isKeyed(p: ModelProvider): Boolean = p.hasKey == true || isChatGpt(p)

    /** The type line under a provider's name. */
    fun typeLine(p: ModelProvider): String = when {
        isChatGpt(p) -> "ChatGPT subscription"
        isSystemOne(p) -> "System One · ${host(p.baseUrl)} · ${p.models.orEmpty().size} models"
        p.kind == ModelProvider.KindValue.custom -> "Custom · OpenAI-compatible · ${host(p.baseUrl)}"
        else -> "API key"
    }

    /** The status line and whether it is a warning. Re-sign-in beats everything else. */
    fun status(p: ModelProvider): Pair<String, Boolean> = when {
        p.status == ModelProvider.StatusValue.reauthRequired -> "Sign-in expired — sign in again" to true
        isChatGpt(p) -> "Connected" to false
        p.hasKey == true -> "Key saved" to false
        else -> "No key" to true
    }

    /**
     * Which providers each model picker offers. The default agent model and the fast model use chat providers; the
     * System One model uses System One only (ModelSettings.swift:554, BackgroundModels.swift:17).
     */
    fun eligibleForChat(p: ModelProvider): Boolean = isKeyed(p) && !isSystemOne(p)
    fun eligibleForSystemOne(p: ModelProvider): Boolean = isKeyed(p) && isSystemOne(p)

    /** Custom base URLs must be http or https with a host (ModelSettings.swift:318-323). */
    fun isValidBaseUrl(url: String): Boolean {
        val uri = runCatching { URI(url.trim()) }.getOrNull() ?: return false
        return (uri.scheme == "http" || uri.scheme == "https") && !uri.host.isNullOrEmpty()
    }

    /** System One model ids: comma-separated, 1 to 20 (ModelSettings.swift:328-331). Null when the list is invalid. */
    fun parseModelIds(text: String): List<String>? {
        val ids = text.split(',').map { it.trim() }.filter { it.isNotEmpty() }
        return ids.takeIf { it.size in 1..20 }
    }

    fun host(url: String?): String = url?.let { runCatching { URI(it).host }.getOrNull() ?: it }.orEmpty()
}
