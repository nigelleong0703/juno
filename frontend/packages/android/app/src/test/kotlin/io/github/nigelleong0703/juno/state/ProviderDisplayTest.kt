package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.ModelProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderDisplayTest {
    private fun provider(
        kind: String = "builtin", auth: String? = null, hasKey: Boolean = true, status: String? = null, baseUrl: String? = null,
        models: List<String>? = null,
    ) = ModelProvider(id = "p", name = "P", kind = kind, auth = auth, hasKey = hasKey, status = status, baseUrl = baseUrl, models = models)

    @Test fun reauthBeatsEverySetupState() {
        val (text, warning) = ProviderDisplay.status(provider(auth = "chatgpt", status = "reauth_required"))
        assertEquals("Sign-in expired — sign in again", text)
        assertTrue(warning)
    }

    @Test fun keyedAndMissingKeysReadDifferently() {
        assertEquals("Key saved" to false, ProviderDisplay.status(provider(hasKey = true)))
        assertEquals("No key" to true, ProviderDisplay.status(provider(hasKey = false)))
    }

    @Test fun systemOneAndCustomTypeLinesNameTheHost() {
        assertEquals("System One · api.example.com · 2 models", ProviderDisplay.typeLine(provider(kind = "systemone", baseUrl = "https://api.example.com/v1", models = listOf("a", "b"))))
        assertEquals("Custom · OpenAI-compatible · llm.local", ProviderDisplay.typeLine(provider(kind = "custom", baseUrl = "http://llm.local:8080")))
    }

    @Test fun systemOneIsNeverAChatDefault() {
        assertFalse(ProviderDisplay.eligibleForChat(provider(kind = "systemone")))
        assertTrue(ProviderDisplay.eligibleForSystemOne(provider(kind = "systemone")))
        assertFalse(ProviderDisplay.eligibleForChat(provider(hasKey = false)))
    }

    @Test fun baseUrlMustBeHttpOrHttpsWithAHost() {
        assertTrue(ProviderDisplay.isValidBaseUrl("https://api.typesafe.ai"))
        assertTrue(ProviderDisplay.isValidBaseUrl("http://10.0.2.2:8787"))
        assertFalse(ProviderDisplay.isValidBaseUrl("ftp://example.com"))
        assertFalse(ProviderDisplay.isValidBaseUrl("https://"))
        assertFalse(ProviderDisplay.isValidBaseUrl("not a url"))
    }

    @Test fun modelIdsAreOneToTwentyCommaSeparated() {
        assertEquals(listOf("a", "b"), ProviderDisplay.parseModelIds(" a, b ,"))
        assertNull(ProviderDisplay.parseModelIds(" , "))
        assertNull(ProviderDisplay.parseModelIds((1..21).joinToString(",") { "m$it" }))
    }
}
