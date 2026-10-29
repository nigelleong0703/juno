package io.github.nigelleong0703.juno.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import java.io.File
import java.security.GeneralSecurityException
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One thing the user chose to keep on this phone: a readable label ("Visa ending 4242") and a kind. The value is encrypted. */
data class VaultEntry(val id: String, val label: String, val kind: String) {
    val kindWord: String
        get() = when (kind) {
            "card" -> "Card detail"
            "password" -> "Password"
            else -> "Detail"
        }
}

/**
 * The vault's keys. Production is [KeystoreVaultKeys]; JVM tests use software keys that model the same window.
 *
 * Two keys exist. The locked key is time-bound: one successful user authentication opens it for [WINDOW_SECONDS], and
 * inside that window any number of entries can be encrypted or decrypted without a prompt. Once the window closes, a cipher
 * init throws the Keystore's UserNotAuthenticatedException. The legacy key (written before the lock existed) needs none; it
 * is re-encrypted under the locked key during the first authorised pass and then deleted.
 */
interface VaultKeys {
    companion object {
        /** How long one authentication keeps the locked key usable. */
        const val WINDOW_SECONDS = 30
    }

    /** True when the phone has a lock screen or biometrics, so the locked key can be used. */
    val canLock: Boolean

    /**
     * A cipher initialised with the locked key for [mode] (with [iv] when decrypting). Creates the key on first use. Null
     * when it cannot be created (no lock enrolled). Throws UserNotAuthenticatedException when the window has closed, and
     * KeyPermanentlyInvalidatedException when the Keystore dropped the key (a new fingerprint was enrolled).
     */
    fun lockedCipher(mode: Int, iv: ByteArray?): Cipher?

    /** The legacy key; created only when [create] is true (a phone with no lock, where nothing can be locked). */
    fun legacyKey(create: Boolean): SecretKey?

    /** Deletes the legacy key once no entry is encrypted with it. */
    fun retireLegacy()

    /** Deletes the locked key after the Keystore invalidated it. */
    fun discardLocked()
}

/**
 * Shows the user's authentication prompt. A success opens the locked key's window (the Keystore records it); the vault then
 * retries its cipher. False means the user did not authenticate (cancelled, failed, or no prompt was possible).
 */
fun interface VaultAccessGate {
    suspend fun authenticate(purpose: String): Boolean

    companion object {
        /** No prompt: for vaults with no lock, and for JVM tests that do not model one. */
        val NotRequired = VaultAccessGate { true }
    }
}

/**
 * Which key an entry is encrypted with, and when to move it. Rows written before the lock have no version and read as
 * [LEGACY]. Pure, so the migration rules are tested without a device.
 */
object VaultMigration {
    const val LEGACY = 1
    const val LOCKED = 2

    /** The version a new row is written with. */
    fun writeVersion(canLock: Boolean): Int = if (canLock) LOCKED else LEGACY

    /** A row to re-encrypt under the locked key on the next authorised use. */
    fun needsReseal(version: Int, canLock: Boolean): Boolean = version == LEGACY && canLock

    /** The legacy key may be deleted once no row still depends on it. */
    fun canRetireLegacy(versions: Collection<Int>): Boolean = LEGACY !in versions
}

/**
 * Saved secure-input values (iOS `SecureVault`). Each value is AES-256-GCM encrypted and kept in one app-private file with
 * its id, label and kind as plain metadata. The file is excluded from backups (dataExtractionRules), because the Keystore
 * keys do not restore and the ciphertext would be unreadable.
 *
 * With a lock on the phone, encrypting and decrypting the locked rows needs the user's authentication, but one successful
 * prompt opens the locked key for [VaultKeys.WINDOW_SECONDS]: every entry used inside that window is free. The Keystore
 * owns the window; this class only prompts when a cipher init says the window has closed, and retries once. Without a lock,
 * the vault behaves as before and says so ([isLocked] is false).
 *
 * File I/O runs on the IO dispatcher; the prompt runs on the main thread inside the gate.
 */
class SecureVault(
    private val file: File,
    private val keys: VaultKeys,
    private val gate: VaultAccessGate = VaultAccessGate.NotRequired,
) {
    private val lock = Any()

    @Volatile
    private var invalidated = false

    /** Whether saved values are behind the user's authentication on this phone. */
    val isLocked: Boolean get() = keys.canLock

    /**
     * True once after the locked rows were dropped because the Keystore invalidated their key (a new fingerprint was
     * enrolled, for example). The caller tells the user; the values are gone and must be entered again.
     */
    fun takeInvalidation(): Boolean {
        val was = invalidated
        invalidated = false
        return was
    }

    /**
     * Saves (or relabels, when [id] exists) an entry and returns its id. Null when the label, kind or value is refused, or
     * when the user did not authenticate. The id is bound into the ciphertext as AAD, so a row cannot be moved under another id.
     * With a lock, saving may prompt, unless the window is already open.
     */
    suspend fun save(value: String, label: String, kind: String, id: String = UUID.randomUUID().toString()): String? {
        val cleanLabel = label.trim()
        if (labelProblem(cleanLabel) != null || value.isEmpty() || kind !in KINDS) return null
        val plain = value.toByteArray(Charsets.UTF_8)
        val row = if (keys.canLock) {
            val cipher = lockedCipher(Cipher.ENCRYPT_MODE, iv = null, purpose = SAVE_PURPOSE) ?: return null
            seal(cipher, id, cleanLabel, kind, plain, VaultMigration.LOCKED) ?: return null
        } else {
            val key = keys.legacyKey(create = true) ?: return null
            val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
            seal(cipher, id, cleanLabel, kind, plain, VaultMigration.LEGACY) ?: return null
        }
        withContext(Dispatchers.IO) { replace(row) }
        migrateRemaining()
        return id
    }

    suspend fun delete(id: String) = withContext(Dispatchers.IO) {
        synchronized(lock) { write(read().filterNot { it.id == id }) }
    }

    /**
     * The decrypted value, after the user has authenticated for it (or inside an open window). Null when there is no such
     * id, when the user did not authenticate, or when the row can no longer be opened (for example the Keystore key was
     * reset): the same answer as a missing item on iOS. The first authorised pass also re-encrypts every other legacy row,
     * with no further prompt.
     */
    suspend fun value(id: String): String? {
        val row = withContext(Dispatchers.IO) { synchronized(lock) { read().firstOrNull { it.id == id } } } ?: return null
        val plain: ByteArray = when {
            VaultMigration.needsReseal(row.keyVersion, keys.canLock) -> {
                val old = openLegacy(row) ?: return null
                if (!reseal(row, old)) return null
                old
            }
            row.keyVersion == VaultMigration.LOCKED -> openLocked(row) ?: return null
            else -> openLegacy(row) ?: return null
        }
        migrateRemaining()
        return plain.toString(Charsets.UTF_8)
    }

    /** The saved entries sorted by label, case-insensitive. Reads metadata only: no decrypt, no prompt. */
    fun entries(): List<VaultEntry> {
        val rows = synchronized(lock) { read() }
        return rows.map { VaultEntry(it.id, it.label, it.kind) }
            .sortedWith(Comparator { a, b -> String.CASE_INSENSITIVE_ORDER.compare(a.label, b.label) })
    }

    /**
     * A locked-key cipher ready for use. If the window is open the init succeeds and nothing is asked. If it has closed,
     * one prompt, then one retry. Null when the user did not authenticate (or no key can be made). A key the Keystore
     * invalidated is discarded together with the rows under it.
     */
    private suspend fun lockedCipher(mode: Int, iv: ByteArray?, purpose: String): Cipher? = try {
        try {
            keys.lockedCipher(mode, iv)
        } catch (e: UserNotAuthenticatedException) {
            if (gate.authenticate(purpose)) keys.lockedCipher(mode, iv) else null
        }
    } catch (e: UserNotAuthenticatedException) {
        null
    } catch (e: KeyPermanentlyInvalidatedException) {
        dropLocked()
        null
    }

    /**
     * The locked key is gone, so the rows encrypted under it can never open again. They are removed here, and [takeInvalidation]
     * tells the caller once so the user can be told to enter those values again.
     */
    private suspend fun dropLocked() {
        keys.discardLocked()
        withContext(Dispatchers.IO) {
            synchronized(lock) { write(read().filter { it.keyVersion != VaultMigration.LOCKED }) }
        }
        invalidated = true
    }

    private fun seal(
        cipher: Cipher,
        id: String,
        label: String,
        kind: String,
        plain: ByteArray,
        version: Int,
    ): StoredEntry? = try {
        cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
        val ciphertext = cipher.doFinal(plain)
        StoredEntry(id, label, kind, encoder.encodeToString(cipher.iv), encoder.encodeToString(ciphertext), version)
    } catch (e: GeneralSecurityException) {
        null
    }

    private suspend fun openLocked(row: StoredEntry): ByteArray? {
        val cipher = lockedCipher(Cipher.DECRYPT_MODE, decoder.decode(row.iv), FILL_PURPOSE) ?: return null
        return try {
            cipher.updateAAD(row.id.toByteArray(Charsets.UTF_8))
            cipher.doFinal(decoder.decode(row.ciphertext))
        } catch (e: GeneralSecurityException) {
            null
        }
    }

    /** Decrypts a legacy row with the no-auth key. No prompt: the legacy key has no user authentication. */
    private fun openLegacy(row: StoredEntry): ByteArray? {
        val key = keys.legacyKey(create = false) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, decoder.decode(row.iv)))
            cipher.updateAAD(row.id.toByteArray(Charsets.UTF_8))
            cipher.doFinal(decoder.decode(row.ciphertext))
        } catch (e: GeneralSecurityException) {
            null
        }
    }

    /** Encrypts [plain] under the locked key with the user's authorisation and writes it over the legacy row. */
    private suspend fun reseal(row: StoredEntry, plain: ByteArray): Boolean {
        val cipher = lockedCipher(Cipher.ENCRYPT_MODE, iv = null, purpose = MIGRATE_PURPOSE) ?: return false
        val sealed = seal(cipher, row.id, row.label, row.kind, plain, VaultMigration.LOCKED) ?: return false
        withContext(Dispatchers.IO) { replace(sealed) }
        return true
    }

    /**
     * After an authorised use, moves every legacy row to the locked key in the same window (so no prompt per row), and
     * deletes the legacy key once no row uses it. A closed window that the user then cancels stops the pass; the rest waits
     * for the next authorised use.
     */
    private suspend fun migrateRemaining() {
        if (!keys.canLock) return
        val legacy = withContext(Dispatchers.IO) { synchronized(lock) { read() } }
            .filter { VaultMigration.needsReseal(it.keyVersion, canLock = true) }
        for (row in legacy) {
            // A legacy row the old key cannot open is left alone: it already reads as missing.
            val plain = openLegacy(row) ?: continue
            if (!reseal(row, plain)) break
        }
        val versions = withContext(Dispatchers.IO) { synchronized(lock) { read() } }.map { it.keyVersion }
        if (VaultMigration.canRetireLegacy(versions)) keys.retireLegacy()
    }

    /** Replaces the row with the same id (or adds it) under the file lock. */
    private fun replace(row: StoredEntry) = synchronized(lock) { write(read().filterNot { it.id == row.id } + row) }

    private fun read(): List<StoredEntry> =
        if (file.exists()) JunoJson.decodeFromString<VaultFile>(file.readText()).entries else emptyList()

    /** Writes a temp file and renames it, so a crash mid-write keeps the previous vault. */
    private fun write(rows: List<StoredEntry>) {
        val temp = File(file.parentFile, "${file.name}.tmp")
        temp.writeText(JunoJson.encodeToString(VaultFile.serializer(), VaultFile(rows)))
        check(temp.renameTo(file)) { "Could not save the vault" }
    }

    @Serializable
    private class VaultFile(val entries: List<StoredEntry> = emptyList())

    @Serializable
    private data class StoredEntry(
        val id: String,
        val label: String,
        val kind: String,
        val iv: String,
        val ciphertext: String,
        /** Absent in files written before the lock; those rows are legacy. */
        val keyVersion: Int = VaultMigration.LEGACY,
    )

    companion object {
        const val FILE_NAME = "secure_vault.json"
        private const val FILL_PURPOSE = "Fill in your saved details"
        private const val SAVE_PURPOSE = "Save this to your saved details"
        private const val MIGRATE_PURPOSE = "Update your saved details to the stronger lock"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private val KINDS = setOf("card", "password", "other")
        private val encoder = Base64.getEncoder()
        private val decoder = Base64.getDecoder()

        private const val MAX_LABEL = 60
        private val BLOCKED_LABEL = Regex(
            """\b(cvc|cvv|cid|csc|2fa|otp|authenticator)\b|security code|verification code|one-time""",
            RegexOption.IGNORE_CASE,
        )

        /**
         * Why a label cannot be saved, or null when it can. The server refuses the same words, so the app refuses first.
         * Surrounding whitespace is ignored.
         */
        fun labelProblem(label: String): String? {
            val text = label.trim()
            return when {
                text.isEmpty() -> "Give it a name"
                text.codePointCount(0, text.length) > MAX_LABEL -> "At most 60 characters"
                BLOCKED_LABEL.containsMatchIn(text) -> "Security and one-time codes are never saved"
                else -> null
            }
        }

        /**
         * The kind an entry saved from a form field gets, or null when that field is never offered for saving (CVC,
         * one-time codes, and the profile's name, email, phone and address). [label] and [prompt] are the field's own
         * text; a bare "name" field is a card only when its text names a card or holder.
         */
        fun kindFor(fieldKind: String, label: String?, prompt: String?): String? = when (fieldKind) {
            "card_number", "card_expiry" -> "card"
            "password" -> "password"
            "name" -> {
                val shown = (label ?: prompt ?: "").lowercase()
                if (listOf("card", "holder", "持卡").any { shown.contains(it) }) "card" else null
            }
            else -> null
        }

        /** The first label for the "Save on this iPhone" switch: the field's text, with the site for a password. */
        fun defaultLabel(label: String?, prompt: String?, fieldKind: String, site: String?): String {
            val base = label ?: prompt ?: "Saved detail"
            if (fieldKind != "password" || site.isNullOrEmpty() || base.contains(site, ignoreCase = true)) return base
            return "$site ${base.lowercase()}"
        }
    }
}
