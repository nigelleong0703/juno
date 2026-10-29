package io.github.nigelleong0703.juno.core

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The session token may only ever reach the signed-in server's origin. */
class ImagesTest {
    private val server = "https://juno.example.com"

    @Test
    fun sameOriginGetsTheToken() {
        assertTrue(isServerOrigin("https://juno.example.com/v1/library/a/thumb".toHttpUrl(), server))
    }

    @Test
    fun otherHostsDoNotGetTheToken() {
        assertFalse(isServerOrigin("https://cdn.example.com/a.png".toHttpUrl(), server))
        assertFalse(isServerOrigin("https://evil.juno.example.com/a.png".toHttpUrl(), server))
        assertFalse(isServerOrigin("https://juno.example.com.evil.net/a.png".toHttpUrl(), server))
    }

    @Test
    fun schemeAndPortMustMatch() {
        assertFalse(isServerOrigin("http://juno.example.com/a.png".toHttpUrl(), server))
        assertFalse(isServerOrigin("https://juno.example.com:8443/a.png".toHttpUrl(), server))
        assertTrue(isServerOrigin("http://10.0.2.2:8787/v1/x".toHttpUrl(), "http://10.0.2.2:8787"))
    }

    @Test
    fun noSessionMeansNoOrigin() {
        assertFalse(isServerOrigin("https://juno.example.com/a.png".toHttpUrl(), null))
        assertFalse(isServerOrigin("https://juno.example.com/a.png".toHttpUrl(), "not a url"))
    }
}
