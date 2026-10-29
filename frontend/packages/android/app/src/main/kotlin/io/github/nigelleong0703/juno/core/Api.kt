package io.github.nigelleong0703.juno.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** `{items, nextCursor}`: every list endpoint. */
@Serializable
data class ListResponse<T>(val items: List<T> = emptyList(), val nextCursor: String? = null)

/** One page of a cursor-paged list: the items and the cursor for the next page (null on the last). */
data class Page<T>(val items: List<T>, val next: String?)

/** Shared OkHttp clients. No cookie jar: native clients send NO cookies and NO Origin (the server rejects a cookie without one). */
internal object Http {
    val client: OkHttpClient = OkHttpClient.Builder().callTimeout(60, TimeUnit.SECONDS).build()

    /** The event stream is open for hours: no read or call timeout. */
    val streaming: OkHttpClient = client.newBuilder().callTimeout(0, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()

    val json = "application/json".toMediaType()
}

/**
 * The HTTP API the web and iOS clients use. Paths are server-relative (`/v1/...`); every call is a suspend function
 * that throws [ApiException] for a refused request and [IOException] when the server cannot be reached.
 */
class Api(val session: Session, private val client: OkHttpClient = Http.client) {

    /** Sends one request and returns the raw body of a 2xx. */
    suspend fun request(method: String, path: String, body: RequestBody? = null): String {
        val url = (session.server.trimEnd('/') + path).toHttpUrlOrNull() ?: throw ApiException.BadServer
        val request = Request.Builder().url(url)
            .header("Authorization", "Bearer ${session.token}")
            .method(method, body ?: if (method == "GET" || method == "DELETE") null else ByteArray(0).toRequestBody())
            .build()
        return client.newCall(request).await().use { response ->
            val text = response.readText()
            if (!response.isSuccessful) throw ApiException.failure(response.code, text)
            text
        }
    }

    suspend inline fun <reified T> get(path: String): T = JunoJson.decodeFromString(request("GET", path))

    /** GET a `{items}` list. */
    suspend inline fun <reified T> list(path: String): List<T> = get<ListResponse<T>>(path).items

    /** GET one page of a cursor-paged list. */
    suspend inline fun <reified T> page(path: String): Page<T> = get<ListResponse<T>>(path).let { Page(it.items, it.nextCursor) }

    /** POST a JSON body (or none); the raw response is returned for the caller to decode (shapes vary: bare or enveloped). */
    suspend inline fun <reified B> post(path: String, body: B): String = request("POST", path, jsonBody(JunoJson.encodeToString(body)))
    suspend fun post(path: String): String = request("POST", path)
    suspend inline fun <reified B> put(path: String, body: B): String = request("PUT", path, jsonBody(JunoJson.encodeToString(body)))
    suspend inline fun <reified B> patch(path: String, body: B) { request("PATCH", path, jsonBody(JunoJson.encodeToString(body))) }
    suspend fun delete(path: String) { request("DELETE", path) }

    /** A POST whose body is the raw bytes under their own content type (the dictation recording, `audio/mp4`). */
    suspend fun postRaw(path: String, bytes: ByteArray, contentType: String): String =
        request("POST", path, bytes.toRequestBody(contentType.toMediaType()))

    @PublishedApi
    internal fun jsonBody(json: String): RequestBody = json.toRequestBody(Http.json)
}

/** The body as text, read off the main thread: [await] returns at the headers, so the body read can still block on the socket. */
internal suspend fun Response.readText(): String = withContext(Dispatchers.IO) { body?.string().orEmpty() }

/** Suspends until the response headers arrive; cancelling the coroutine cancels the call. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)
        override fun onFailure(call: Call, e: IOException) { if (!cont.isCancelled) cont.resumeWithException(e) }
    })
    cont.invokeOnCancellation { cancel() }
}
