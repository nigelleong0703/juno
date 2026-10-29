package io.github.nigelleong0703.juno.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException

/** Every failure of a request, with the text the user should read as [message] (same wording as iOS `APIError`). */
sealed class ApiException(override val message: String) : Exception(message) {
    /** A non-2xx without a structured body; [text] is whatever readable part the body had. */
    class Http(val status: Int, text: String) : ApiException(text.ifEmpty { "Server responded $status" })

    /** A JSON error body `{error:{code,message}}`: [code] is stable and meant for the client to branch on. */
    class Api(val status: Int, val code: String, text: String) : ApiException(text.ifEmpty { "Server responded $status" })

    /** A 400 with per-field problems: the keys are question field ids. */
    class Fields(text: String, val errors: Map<String, String>) : ApiException(text.ifEmpty { "Some answers need fixing." })

    object BadServer : ApiException("Enter a server address like http://100.x.y.z:8787")
    object NotSignedIn : ApiException("Sign in to a server first.")

    /** The refusal that ends a session: the token is no longer valid. */
    val isUnauthorized: Boolean
        get() = (this as? Http)?.status == 401 || (this as? Api)?.status == 401

    companion object {
        /** Builds the exception for a failed response from its status and raw body. */
        fun failure(status: Int, body: String): ApiException {
            val error = parse(body)?.get("error") as? JsonObject
            val code = (error?.get("code") as? JsonPrimitive)?.contentOrNull
            if (error != null && code != null) {
                val text = (error["message"] as? JsonPrimitive)?.contentOrNull.orEmpty()
                val fields = fieldErrors(error)
                return if (status == 400 && fields.isNotEmpty()) Fields(text, fields) else Api(status, code, text)
            }
            return Http(status, message(body))
        }

        /**
         * The readable part of an error body: `{error:{message}}`, else `message`, else OAuth-style
         * `error_description` (`{error:"invalid_request", error_description:"..."}`), else a plain `error` string.
         */
        fun message(body: String): String {
            val obj = parse(body) ?: return ""
            ((obj["error"] as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull?.let { return it }
            for (key in listOf("message", "error_description", "error")) {
                (obj[key] as? JsonPrimitive)?.contentOrNull?.let { return it }
            }
            return ""
        }

        /** Per-field messages from `details.fields` / `fieldErrors` / `fields`, as `{id: msg}`, `{id: [msg]}` or `[{id|field, message}]`. */
        fun fieldErrors(error: JsonObject): Map<String, String> {
            val details = error["details"] as? JsonObject
            val raw = details?.get("fields") ?: details?.get("fieldErrors") ?: error["fields"] ?: error["fieldErrors"] ?: error["details"]
            val out = mutableMapOf<String, String>()
            when (raw) {
                is JsonObject -> raw.forEach { (key, value) ->
                    val text = (value as? JsonPrimitive)?.contentOrNull
                        ?: ((value as? JsonArray)?.firstOrNull() as? JsonPrimitive)?.contentOrNull
                    if (text != null) out[key] = text
                }
                is JsonArray -> raw.forEach { item ->
                    val o = item as? JsonObject ?: return@forEach
                    val id = listOf("id", "field", "fieldId").firstNotNullOfOrNull { (o[it] as? JsonPrimitive)?.contentOrNull }
                    val text = (o["message"] as? JsonPrimitive)?.contentOrNull
                    if (id != null && text != null) out[id] = text
                }
                else -> {}
            }
            return out
        }

        private fun parse(body: String): JsonObject? =
            runCatching { JunoJson.parseToJsonElement(body) }.getOrNull() as? JsonObject
    }
}

/**
 * What to show the user for any thrown error: network failures say what to do, server answers pass through as written.
 */
val Throwable.userMessage: String
    get() = when (this) {
        is ApiException -> message
        is IOException -> "Can't reach the server. Check your connection, or the server address."
        else -> message ?: "Something went wrong."
    }

/** A request dropped because its coroutine went away: not something to tell the user about. */
val Throwable.isCancellation: Boolean get() = this is CancellationException
