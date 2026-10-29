package io.github.nigelleong0703.juno.state

import android.content.ContextWrapper
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.core.Api
import io.github.nigelleong0703.juno.core.Session
import io.github.nigelleong0703.juno.core.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * World.resolve decides which endpoint carries a card's decision. A standard resume entry answers one interrupt, so
 * it is used only when no other card of the same segment is still pending; otherwise the product resolve route is.
 */
class WorldResolveRouteTest {
    private val sent = CopyOnWriteArrayList<Pair<String, String>>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun stop() = scope.cancel()

    private fun world(vararg requests: Request): World {
        val recorder = Interceptor { chain ->
            val buffer = Buffer()
            chain.request().body?.writeTo(buffer)
            sent += chain.request().url.encodedPath to buffer.readUtf8()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }
        val world = World(SessionStore(ContextWrapper(null)), scope)
        world.api = Api(Session("https://agui.fixture.invalid", "fixture", "owner", "Fixture", "fixture@example.invalid"),
            OkHttpClient.Builder().addInterceptor(recorder).build())
        world.update { it.copy(requests = requests.toList()) }
        return world
    }

    private fun card(id: String) = Request(id = id, kind = "approval", status = "pending", agentId = "a1", conversationId = "c1", runId = "r1")

    private fun awaitSent(): Pair<String, String> {
        val deadline = System.currentTimeMillis() + 5_000
        while (sent.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(1, sent.size)
        return sent.single()
    }

    @Test fun `the only pending card is answered through the standard resume entry`() {
        world(card("req1")).resolve("req1", "approved")
        val (path, body) = awaitSent()
        assertEquals("/v1/conversations/c1/runs", path)
        val resume = Json.parseToJsonElement(body).jsonObject["resume"] as JsonArray
        val entry = resume.single().jsonObject
        assertEquals("req1", entry["interruptId"]!!.jsonPrimitive.content)
        assertEquals("resolved", entry["status"]!!.jsonPrimitive.content)
        assertEquals("approve", (entry["payload"] as JsonObject)["action"]!!.jsonPrimitive.content)
    }

    @Test fun `with another card of the segment still pending the product resolve route carries the decision`() {
        val world = world(card("req1"), card("req2"))
        world.resolve("req1", "approved")
        val (path, body) = awaitSent()
        assertEquals("/v1/requests/req1/resolve", path)
        val parsed = Json.parseToJsonElement(body).jsonObject
        assertEquals("approve", parsed["action"]!!.jsonPrimitive.content)
        assertNull(parsed["resume"])
        assertEquals("pending", world.state.value.request("req2")?.status)
        assertEquals("approved", world.state.value.request("req1")?.status)
    }
}
