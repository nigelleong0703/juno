package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.SecureInputEncryption
import io.github.nigelleong0703.juno.contract.SecureInputField
import io.github.nigelleong0703.juno.core.SecureSeal
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom
import java.time.YearMonth
import java.util.Base64

class SecureInputLogicTest {
    private fun field(id: String, kind: String? = "text", label: String? = null, required: Boolean? = null, max: Long? = null) =
        SecureInputField(id = id, kind = kind, label = label, required = required, maxLength = max)

    private val now = YearMonth.of(2026, 10)

    @Test fun `card numbers are typed in groups of four`() {
        val card = field("n", kind = "card_number")
        assertEquals("4242 4242 4242 4242", SecureKind.sanitize(card, "4242424242424242"))
        assertEquals("4242 4", SecureKind.sanitize(card, "42424x"))
    }

    @Test fun `expiry is typed as MM slash YY and codes are digits only`() {
        assertEquals("12/26", SecureKind.sanitize(field("e", kind = "card_expiry"), "1226"))
        assertEquals("12", SecureKind.sanitize(field("e", kind = "card_expiry"), "12"))
        assertEquals("123", SecureKind.sanitize(field("c", kind = "card_cvc"), "1a2b3c"))
    }

    @Test fun `a decimal number keeps one point and a leading minus`() {
        val n = field("x", kind = "number")
        assertEquals("-1.25", SecureKind.sanitize(n, "-1.2.5"))
        assertEquals("", SecureKind.sanitize(n, "a"))
    }

    @Test fun `the length limit cuts what is typed`() {
        assertEquals("abc", SecureKind.sanitize(field("t", max = 3), "abcdef"))
    }

    @Test fun `a text field with an old kind is resolved from its label`() {
        assertEquals("email", SecureKind.resolve(field("m", kind = "text", label = "Your email")))
        assertEquals("text", SecureKind.resolve(field("t", kind = "text", label = "Favourite colour")))
        assertEquals("password", SecureKind.resolve(field("p", kind = "password", label = "Email")))
    }

    @Test fun `a valid card number passes the Luhn check and a wrong one does not`() {
        val card = field("n", kind = "card_number")
        assertNull(SecureKind.validate(card, "4242 4242 4242 4242", now))
        assertEquals("Enter a valid card number", SecureKind.validate(card, "4242 4242 4242 4241", now))
    }

    @Test fun `an expired card is refused and the current month is not`() {
        val expiry = field("e", kind = "card_expiry")
        assertEquals("This card has expired", SecureKind.validate(expiry, "09/26", now))
        assertNull(SecureKind.validate(expiry, "10/26", now))
        assertNull(SecureKind.validate(expiry, "01/27", now))
        assertEquals("Enter the expiry as MM/YY", SecureKind.validate(expiry, "13/27", now))
    }

    @Test fun `a required field must be filled and an optional one may be empty`() {
        assertEquals("Required", SecureKind.validate(field("r", label = "Name"), "  ", now))
        assertNull(SecureKind.validate(field("o", label = "Name", required = false), "", now))
    }

    @Test fun `numbers respect the field's bounds`() {
        val n = SecureInputField(id = "q", kind = "number", min = 1.0, max = 10.0)
        assertEquals("Must be at least 1.0", SecureKind.validate(n, "0", now))
        assertEquals("Must be at most 10.0", SecureKind.validate(n, "11", now))
        assertNull(SecureKind.validate(n, "7", now))
    }

    @Test fun `what is sent drops the card's spaces and the empty fields`() {
        val fields = listOf(field("n", kind = "card_number"), field("c", kind = "card_cvc"), field("x", label = "Note"))
        val sent = SecureKind.outputs(fields, mapOf("n" to "4242 4242 4242 4242", "c" to "", "x" to "  hi  "))
        assertEquals(mapOf("n" to "4242424242424242", "x" to "hi"), sent)
    }

    private val computerKey = X25519PrivateKeyParameters(SecureRandom())
    private val encryption = SecureInputEncryption(
        alg = SecureSeal.ALGORITHM,
        keyId = "k1",
        publicKey = Base64.getEncoder().encodeToString(computerKey.generatePublicKey().encoded),
    )

    @Test fun `only the filled fields are sealed, each under its own id`() {
        val fields = listOf(field("card", kind = "card_number"), field("cvc", kind = "card_cvc"), field("name", label = "Name"))
        val sealed = sealSecureFields(fields, mapOf("card" to "4242424242424242", "name" to "Ada"), encryption, "req_1")
        assertEquals(setOf("card", "name"), sealed.keys)
        val card = sealed.getValue("card")
        assertTrue(card.epk.orEmpty().isNotEmpty() && card.nonce.orEmpty().isNotEmpty() && card.ciphertext.orEmpty().isNotEmpty())
        assertNotEquals(card.epk, sealed.getValue("name").epk)
    }

    @Test fun `a request without a usable key is refused before anything is sealed`() {
        val fields = listOf(field("card", kind = "card_number"))
        assertThrows(SecureSeal.OlderComputer::class.java) {
            sealSecureFields(fields, mapOf("card" to "4242424242424242"), encryption = null, requestId = "req_1")
        }
        assertFalse(sealSecureFields(fields, emptyMap(), null, "req_1").isNotEmpty())
    }
}
