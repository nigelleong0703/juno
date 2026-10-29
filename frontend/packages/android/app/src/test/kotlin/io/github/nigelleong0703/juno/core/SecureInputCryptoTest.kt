package io.github.nigelleong0703.juno.core

import io.github.nigelleong0703.juno.contract.SecureInputEncryption
import io.github.nigelleong0703.juno.core.SecureSeal.ALGORITHM
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class SecureInputCryptoTest {
    private val b64 = Base64.getDecoder()

    // The shared vector from SecureInputTests.swift (backend secure-input-vector.json). Same bytes as the iOS test.
    private val vectorPublicKey = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw="
    private val vectorRequest = "req_secure_vector_1"
    private val vectorField = "f1"
    private val vectorRef = "e12"
    private val vectorPlain = "4242 4242 4242 4242 é"
    private val vectorEphemeral = "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8="
    private val vectorNonce = "EBESExQVFhcYGRob"

    private val encryption = SecureInputEncryption(alg = ALGORITHM, keyId = "aaa8fff703b50b22", publicKey = vectorPublicKey)

    @Test fun `sealing matches the iOS vector byte for byte`() {
        val sealed = SecureSeal.seal(
            vectorPlain, encryption, vectorRequest, vectorField, vectorRef,
            ephemeralPrivateKey = b64.decode(vectorEphemeral), nonce = b64.decode(vectorNonce),
        )
        assertEquals("YFpyXSpK3+6xop4X7dYhwbdZPujNvESsbEq24vgF0jw=", sealed.epk)
        assertEquals(vectorNonce, sealed.nonce)
        assertEquals("5ofwMWoFizczNi3M7AfXP4YSSPNzjaEv/awae7TtwSuGeLuie9g=", sealed.ciphertext)
    }

    @Test fun `a request without an encryption key is from an older computer`() {
        val error = assertThrows(SecureSeal.OlderComputer::class.java) {
            SecureSeal.seal("x", encryption = null, requestId = "r", fieldId = "f1", ref = null)
        }
        assertEquals("This request is from an older computer — cancel and ask again.", error.message)
    }

    @Test fun `a different algorithm is refused`() {
        assertThrows(SecureSeal.OlderComputer::class.java) {
            SecureSeal.seal("x", encryption.copy(alg = "X25519-HKDF-SHA256-CHACHA"), "r", "f1", null)
        }
    }

    @Test fun `a public key that is not 32 bytes of base64 is refused`() {
        val short = Base64.getEncoder().encodeToString(ByteArray(31))
        assertThrows(SecureSeal.OlderComputer::class.java) {
            SecureSeal.seal("x", encryption.copy(publicKey = short), "r", "f1", null)
        }
        assertThrows(SecureSeal.OlderComputer::class.java) {
            SecureSeal.seal("x", encryption.copy(publicKey = null), "r", "f1", null)
        }
    }

    @Test fun `a sealed value opens with the computer's private key and each seal uses a fresh ephemeral key`() {
        val computer = X25519PrivateKeyParameters(SecureRandom())
        val enc = SecureInputEncryption(ALGORITHM, "k1", Base64.getEncoder().encodeToString(computer.generatePublicKey().encoded))
        val first = SecureSeal.seal("123 Main St", enc, "req_9", "addr", "e4")
        val second = SecureSeal.seal("123 Main St", enc, "req_9", "addr", "e4")
        assertNotEquals(first.epk, second.epk)
        assertNotEquals(first.nonce, second.nonce)
        assertEquals("123 Main St", open(computer, first, "req_9", "addr", "e4"))
    }

    /** The receiving side: the computer's key and the sealed value's epk give the same AES key the seal used. */
    private fun open(computer: X25519PrivateKeyParameters, sealed: io.github.nigelleong0703.juno.contract.SealedSecureValue, requestId: String, fieldId: String, ref: String?): String {
        val epk = X25519PublicKeyParameters(b64.decode(sealed.epk), 0)
        val shared = ByteArray(32)
        computer.generateSecret(epk, shared, 0)
        val key = ByteArray(32)
        HKDFBytesGenerator(SHA256Digest()).apply {
            init(HKDFParameters(shared, requestId.toByteArray(), "juno-secure-input-v1".toByteArray()))
            generateBytes(key, 0, 32)
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, b64.decode(sealed.nonce)))
            updateAAD("$requestId|$fieldId|${ref ?: ""}".toByteArray())
        }
        return String(cipher.doFinal(b64.decode(sealed.ciphertext)))
    }
}
