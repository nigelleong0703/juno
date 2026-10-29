package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.core.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelErrorsTest {
    @Test fun knownProviderCodesGetTheirCopy() {
        assertEquals(
            "That address points to a private or local network, which can't be reached from the server. Use a public https address.",
            ModelErrors.saveMessage(ApiException.Api(400, "MODEL_URL_BLOCKED", "")),
        )
    }

    @Test fun unknownAndNonApiFailuresGetTheGenericLine() {
        assertEquals("Couldn't save. Check the details and try again.", ModelErrors.saveMessage(ApiException.Api(500, "SOMETHING_NEW", "")))
        assertEquals("Couldn't save. Check the details and try again.", ModelErrors.saveMessage(java.io.IOException("offline")))
    }

    @Test fun catalogFailureOnlyNamesTheUnavailableCase() {
        assertEquals("This provider's model list isn't available right now.", ModelErrors.catalogMessage(ApiException.Api(503, "MODEL_CATALOG_UNAVAILABLE", "")))
        assertEquals("Couldn't load models.", ModelErrors.catalogMessage(ApiException.Api(500, "OTHER", "")))
    }

    @Test fun onlyAClientErrorWithASpentCodeRestartsTheLogin() {
        assertEquals("That sign-in was already used.", ModelErrors.spentChatGptLogin(ApiException.Api(400, "LOGIN_INVALID", "")))
        assertNull("a 500 is not a spent login", ModelErrors.spentChatGptLogin(ApiException.Api(500, "LOGIN_INVALID", "")))
        assertNull("a network error keeps the paste", ModelErrors.spentChatGptLogin(java.io.IOException()))
    }

    @Test fun setupTextIsFoundWhateverTheSpacingAndCase() {
        assertTrue(ModelErrors.isSetupError("Add a key in Settings  >  Models to continue"))
        assertTrue(ModelErrors.isSetupError("open SETTINGS>MODELS"))
        assertFalse(ModelErrors.isSetupError("rate limited"))
        assertFalse(ModelErrors.isSetupError(null))
    }
}
