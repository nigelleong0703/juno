package io.github.nigelleong0703.juno.core

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The authenticators the vault accepts. API 30+ also takes the lock-screen credential; below that only strong biometrics
 * can unlock a time-bound key, so the lock-screen fallback is not offered there.
 */
object VaultAuthenticators {
    val prompt: Int
        get() = if (Build.VERSION.SDK_INT >= 30) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        }
}

/**
 * The Keystore keys for the vault. The locked key is AES-256-GCM, non-exportable, and stays usable for [VaultKeys.WINDOW_SECONDS]
 * after one successful user authentication (a time-bound key: no CryptoObject). The legacy key keeps its original alias
 * and needs none; it only survives until its rows are migrated.
 */
class KeystoreVaultKeys(private val context: Context) : VaultKeys {
    override val canLock: Boolean
        get() = BiometricManager.from(context).canAuthenticate(VaultAuthenticators.prompt) == BiometricManager.BIOMETRIC_SUCCESS

    override fun lockedCipher(mode: Int, iv: ByteArray?): Cipher? {
        val key = existing(LOCKED_ALIAS) ?: if (canLock) generate(lockedSpec()) else return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        if (iv == null) cipher.init(mode, key) else cipher.init(mode, key, GCMParameterSpec(TAG_BITS, iv))
        return cipher
    }

    override fun legacyKey(create: Boolean): SecretKey? {
        existing(LEGACY_ALIAS)?.let { return it }
        return if (create) generate(legacySpec()) else null
    }

    override fun retireLegacy() {
        store().deleteEntry(LEGACY_ALIAS)
    }

    override fun discardLocked() {
        store().deleteEntry(LOCKED_ALIAS)
    }

    private fun store(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existing(alias: String): SecretKey? = store().getKey(alias, null) as? SecretKey

    private fun generate(spec: KeyGenParameterSpec): SecretKey =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply { init(spec) }.generateKey()

    private fun lockedSpec(): KeyGenParameterSpec {
        val builder = baseSpec(LOCKED_ALIAS).setUserAuthenticationRequired(true)
        if (Build.VERSION.SDK_INT >= 30) {
            builder.setUserAuthenticationParameters(
                VaultKeys.WINDOW_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(VaultKeys.WINDOW_SECONDS)
        }
        return builder.build()
    }

    private fun legacySpec(): KeyGenParameterSpec = baseSpec(LEGACY_ALIAS).build()

    private fun baseSpec(alias: String): KeyGenParameterSpec.Builder =
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        /** The original no-auth key: keep the alias so existing rows still open. */
        const val LEGACY_ALIAS = "juno.vault.v1"
        const val LOCKED_ALIAS = "juno.vault.v2"
    }
}
