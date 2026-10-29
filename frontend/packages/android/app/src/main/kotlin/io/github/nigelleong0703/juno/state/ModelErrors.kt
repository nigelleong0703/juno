package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.core.ApiException

/**
 * User copy for the model-provider failures (iOS ModelSetupNotice.swift:5-33). Pure, so the mapping is unit-tested.
 * The backend's error codes are the contract; the text is the only thing a screen shows.
 */
object ModelErrors {
    private val setupText = Regex("""settings\s*>\s*models""", RegexOption.IGNORE_CASE)

    /** The line under a provider form when a save fails. */
    fun saveMessage(e: Throwable): String = when ((e as? ApiException.Api)?.code) {
        "UNKNOWN_PROVIDER" -> "That provider isn't available. Pick one from the list."
        "UNKNOWN_MODEL" -> "That model isn't in the provider's list. Pick another."
        "UNSUPPORTED_EFFORT" -> "That model doesn't offer this thinking level. Pick another level."
        "MODEL_URL_BLOCKED" -> "That address points to a private or local network, which can't be reached from the server. Use a public https address."
        "BUILTIN_ENDPOINT_FIXED" -> "A built-in provider's address can't be changed."
        "NOT_FOUND" -> "That provider no longer exists. Refresh and try again."
        "MODEL_CATALOG_UNAVAILABLE" -> "The provider's model list isn't available right now. Check the key and try again."
        else -> "Couldn't save. Check the details and try again."
    }

    /** Copy when a provider's model list cannot be loaded (iOS ModelSettings.swift:638). */
    fun catalogMessage(e: Throwable): String =
        if ((e as? ApiException.Api)?.code == "MODEL_CATALOG_UNAVAILABLE") "This provider's model list isn't available right now."
        else "Couldn't load models."

    /**
     * A ChatGPT sign-in that is already spent: the caller starts a fresh login and shows the reason. Null means the
     * login is still good (a network error, say) and the paste stays.
     */
    fun spentChatGptLogin(e: Throwable): String? {
        val api = e as? ApiException.Api ?: return null
        if (api.status != 400 && api.status != 404) return null
        return when (api.code) {
            "CALLBACK_INVALID" -> "The address wasn't the full one from the browser."
            "STATE_MISMATCH" -> "The address came from a different sign-in."
            "LOGIN_EXPIRED" -> "The sign-in link expired."
            "LOGIN_INVALID" -> "That sign-in was already used."
            "NOT_FOUND" -> "That sign-in was not found."
            else -> null
        }
    }

    /**
     * Run failures arrive only as text, and every message a provider setting fixes names "Settings > Models": that is how a
     * chat finds the capsule to show. Brittle by design until the backend sends a typed code (spec 5.17).
     */
    fun isSetupError(runError: String?): Boolean = runError != null && setupText.containsMatchIn(runError)
}
