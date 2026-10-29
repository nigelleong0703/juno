package io.github.nigelleong0703.juno.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Account mode: Better Auth under `/auth`. Both calls return a [Session] whose token is the Bearer for [Api]. */
object Auth {
    @Serializable private class User(val id: String, val name: String = "", val email: String = "")
    @Serializable private class AuthResult(val token: String, val user: User)

    /** POST /auth/sign-in/email -> { token, user }. */
    suspend fun signIn(server: String, email: String, password: String): Session =
        authenticate(server, "auth/sign-in/email", mapOf("email" to email, "password" to password))

    /** POST /auth/sign-up/email -> { token, user }; a new account starts empty. */
    suspend fun signUp(server: String, name: String, email: String, password: String): Session =
        authenticate(server, "auth/sign-up/email", mapOf("name" to name, "email" to email, "password" to password))

    private suspend fun authenticate(server: String, path: String, body: Map<String, String>): Session {
        val url = "${server.trim().trimEnd('/')}/$path".toHttpUrlOrNull() ?: throw ApiException.BadServer
        val request = Request.Builder().url(url).post(JunoJson.encodeToString(body).toRequestBody(Http.json)).build()
        val text = Http.client.newCall(request).await().use { response ->
            val raw = response.readText()
            // Sign-in errors are plain Http errors on purpose: the message is what Better Auth says ("Invalid email or password").
            if (!response.isSuccessful) throw ApiException.Http(response.code, ApiException.message(raw))
            raw
        }
        val result = JunoJson.decodeFromString<AuthResult>(text)
        return Session(server.trim().trimEnd('/'), result.token, result.user.id, result.user.name, result.user.email)
    }
}
