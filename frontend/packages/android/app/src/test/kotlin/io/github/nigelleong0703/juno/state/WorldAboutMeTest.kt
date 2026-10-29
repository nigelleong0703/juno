package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.core.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorldAboutMeTest {
    @Test fun `only a 409 HOME_CONFLICT counts as a conflict`() {
        assertTrue(ApiException.Api(409, "HOME_CONFLICT", "changed").isHomeConflict)
        assertFalse(ApiException.Api(409, "OTHER", "x").isHomeConflict)
        assertFalse(ApiException.Http(409, "HOME_CONFLICT").isHomeConflict)
        assertFalse(IllegalStateException("x").isHomeConflict)
    }

    @Test fun `home paths keep their slashes and encode each segment`() {
        assertEquals("USER.md", encodeHomePath("USER.md"))
        assertEquals("agents/a%20b/IDENTITY.md", encodeHomePath("agents/a b/IDENTITY.md"))
        assertEquals("agents/a%2Bb/SOUL.md", encodeHomePath("agents/a+b/SOUL.md"))
    }
}
