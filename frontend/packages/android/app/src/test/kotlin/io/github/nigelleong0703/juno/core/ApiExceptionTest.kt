package io.github.nigelleong0703.juno.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiExceptionTest {
    @Test fun `nested error message wins`() {
        assertEquals("Nope", ApiException.message("""{"error":{"message":"Nope"},"message":"other"}"""))
    }

    @Test fun `better auth style message`() {
        assertEquals("Invalid email or password", ApiException.message("""{"message":"Invalid email or password","code":"INVALID"}"""))
    }

    @Test fun `oauth error_description is the readable part`() {
        assertEquals("Bad grant", ApiException.message("""{"error":"invalid_request","error_description":"Bad grant"}"""))
    }

    @Test fun `plain error string is the last fallback`() {
        assertEquals("boom", ApiException.message("""{"error":"boom"}"""))
    }

    @Test fun `non json bodies have no message`() {
        assertEquals("", ApiException.message("<html>502</html>"))
    }

    @Test fun `empty message falls back to the status`() {
        assertEquals("Server responded 502", ApiException.failure(502, "").message)
        assertEquals("Server responded 409", ApiException.failure(409, """{"error":{"code":"X"}}""").message)
    }

    @Test fun `structured error keeps its code`() {
        val e = ApiException.failure(409, """{"error":{"code":"USER_CONTROL","message":"You hold the screen"}}""") as ApiException.Api
        assertEquals("USER_CONTROL", e.code)
        assertEquals("You hold the screen", e.message)
    }

    @Test fun `400 with field errors becomes Fields in every accepted shape`() {
        val map = ApiException.failure(400, """{"error":{"code":"VALIDATION","message":"Fix","details":{"fields":{"a":"bad","b":["first","second"]}}}}""")
        assertEquals(mapOf("a" to "bad", "b" to "first"), (map as ApiException.Fields).errors)
        val list = ApiException.failure(400, """{"error":{"code":"V","fieldErrors":[{"field":"x","message":"no"},{"id":"y","message":"nope"}]}}""")
        assertEquals(mapOf("x" to "no", "y" to "nope"), (list as ApiException.Fields).errors)
    }

    @Test fun `field errors on a non-400 stay an Api error`() {
        assertTrue(ApiException.failure(422, """{"error":{"code":"V","details":{"fields":{"a":"bad"}}}}""") is ApiException.Api)
    }

    @Test fun `401 is unauthorized in both shapes`() {
        assertTrue(ApiException.failure(401, "").isUnauthorized)
        assertTrue(ApiException.failure(401, """{"error":{"code":"UNAUTHENTICATED"}}""").isUnauthorized)
        assertEquals(false, ApiException.failure(500, "").isUnauthorized)
    }

    @Test fun `network failures tell the user what to do`() {
        assertTrue(java.io.IOException("x").userMessage.startsWith("Can't reach the server"))
        assertEquals("Enter a server address like http://100.x.y.z:8787", ApiException.BadServer.userMessage)
    }
}
