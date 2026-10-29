package io.github.nigelleong0703.juno.core

import io.github.nigelleong0703.juno.contract.SealedSecureValue
import io.github.nigelleong0703.juno.contract.SecureInputEncryption
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Seals a secure-input value to the computer's X25519 key (iOS `SecureSeal`, BACKEND 8.7 item 7), so the server, the
 * model and the network only carry ciphertext. Must stay byte-identical with iOS: the shared vector in
 * SecureInputCryptoTest pins it. BouncyCastle does the X25519 and HKDF because platform X25519 support varies by API level.
 */
object SecureSeal {
    const val ALGORITHM = "X25519-HKDF-SHA256-AES256GCM"
    private const val INFO = "juno-secure-input-v1"
    private const val KEY_BYTES = 32
    private const val NONCE_BYTES = 12
    private const val TAG_BITS = 128
    private val random = SecureRandom()

    /** The request carries no usable `encryption`: it comes from an older computer. */
    class OlderComputer : Exception("This request is from an older computer — cancel and ask again.")

    /**
     * `ephemeralPrivateKey` and `nonce` are only injected by the shared test vector. In production both are fresh random
     * values per call, and the ephemeral private key is never kept.
     */
    fun seal(
        value: String,
        encryption: SecureInputEncryption?,
        requestId: String,
        fieldId: String,
        ref: String?,
        ephemeralPrivateKey: ByteArray? = null,
        nonce: ByteArray? = null,
    ): SealedSecureValue {
        if (encryption == null || encryption.alg != ALGORITHM) throw OlderComputer()
        val peer = encryption.publicKey?.let(::decodeBase64OrNull)?.takeIf { it.size == KEY_BYTES } ?: throw OlderComputer()

        val ephemeral = X25519PrivateKeyParameters(ephemeralPrivateKey ?: randomBytes(KEY_BYTES), 0)
        val epk = ephemeral.generatePublicKey().encoded
        val shared = ByteArray(KEY_BYTES)
        ephemeral.generateSecret(X25519PublicKeyParameters(peer, 0), shared, 0)

        // Salt is the request id, so a value sealed for one request cannot be replayed into another.
        val key = ByteArray(KEY_BYTES)
        HKDFBytesGenerator(SHA256Digest()).apply {
            init(HKDFParameters(shared, requestId.toByteArray(Charsets.UTF_8), INFO.toByteArray(Charsets.UTF_8)))
            generateBytes(key, 0, KEY_BYTES)
        }
        shared.fill(0)

        val iv = nonce ?: randomBytes(NONCE_BYTES)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            updateAAD("$requestId|$fieldId|${ref.orEmpty()}".toByteArray(Charsets.UTF_8))
        }
        key.fill(0)
        // doFinal returns ciphertext then the 16-byte tag, the same layout iOS sends.
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))

        return SealedSecureValue(
            epk = Base64.getEncoder().encodeToString(epk),
            nonce = Base64.getEncoder().encodeToString(iv),
            ciphertext = Base64.getEncoder().encodeToString(ciphertext),
        )
    }

    private fun decodeBase64OrNull(text: String): ByteArray? =
        runCatching { Base64.getDecoder().decode(text) }.getOrNull()

    private fun randomBytes(size: Int): ByteArray = ByteArray(size).also(random::nextBytes)
}
