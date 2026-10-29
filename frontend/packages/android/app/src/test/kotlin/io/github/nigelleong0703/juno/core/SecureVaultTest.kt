package io.github.nigelleong0703.juno.core

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

private const val WINDOW_MS = VaultKeys.WINDOW_SECONDS * 1000L

/**
 * Software stand-in for the Keystore keys. The locked key is time-bound like the real one: it opens for [WINDOW_MS] after
 * [authenticate], and a cipher init outside that window throws UserNotAuthenticatedException. [clock] is injected so the
 * expiry can be moved without sleeping. [invalidated] stands for the Keystore dropping the key.
 */
private class SoftwareKeys(
    override var canLock: Boolean,
    private val clock: () -> Long,
    var legacy: SecretKey?,
) : VaultKeys {
    private var locked: SecretKey = newKey()
    var authenticatedAt: Long? = null
    var invalidated = false
    var retired = false

    fun authenticate() {
        authenticatedAt = clock()
    }

    override fun lockedCipher(mode: Int, iv: ByteArray?): Cipher? {
        if (!canLock) return null
        if (invalidated) throw KeyPermanentlyInvalidatedException()
        val at = authenticatedAt
        if (at == null || clock() - at >= WINDOW_MS) throw UserNotAuthenticatedException()
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            if (iv == null) init(mode, locked) else init(mode, locked, GCMParameterSpec(128, iv))
        }
    }

    override fun legacyKey(create: Boolean): SecretKey? = legacy ?: if (create) newKey().also { legacy = it } else null

    override fun retireLegacy() {
        legacy = null
        retired = true
    }

    override fun discardLocked() {
        locked = newKey()
        invalidated = false
        authenticatedAt = null
    }
}

/** Counts every prompt the vault shows. [allow] false means the user cancels; [opensWindow] false means a prompt that succeeds but opens nothing. */
private class CountingGate(private val keys: SoftwareKeys) : VaultAccessGate {
    val purposes = mutableListOf<String>()
    var allow = true
    var opensWindow = true

    override suspend fun authenticate(purpose: String): Boolean {
        purposes += purpose
        if (!allow) return false
        if (opensWindow) keys.authenticate()
        return true
    }
}

class SecureVaultTest {
    @get:Rule val folder = TemporaryFolder()

    /** The fake clock, in milliseconds. Move it forward to close the window. */
    private var now = 0L

    private inner class Setup(canLock: Boolean = true, legacy: SecretKey? = null) {
        val keys = SoftwareKeys(canLock, { now }, legacy)
        val gate = CountingGate(keys)
        val vault = vault(keys, gate)
    }

    private fun vault(keys: SoftwareKeys, gate: VaultAccessGate) =
        SecureVault(folder.root.resolve(SecureVault.FILE_NAME), keys, gate)

    // MARK: Label rules (pure)

    @Test fun `a label needs a name and at most 60 characters`() {
        assertEquals("Give it a name", SecureVault.labelProblem("   "))
        assertNull(SecureVault.labelProblem("a".repeat(60)))
        assertEquals("At most 60 characters", SecureVault.labelProblem("a".repeat(61)))
    }

    @Test fun `security and one-time codes are refused whatever the case`() {
        listOf("Card CVC", "cvv 123", "2FA backup", "OTP", "Authenticator app", "Security Code", "verification code", "One-Time").forEach {
            assertEquals(it, "Security and one-time codes are never saved", SecureVault.labelProblem(it))
        }
    }

    @Test fun `codes are matched on word boundaries only`() {
        assertNull(SecureVault.labelProblem("Cidade pass"))
        assertNull(SecureVault.labelProblem("Visa ending 4242"))
    }

    // MARK: Field to kind (pure)

    @Test fun `card number, expiry and password fields are saved as card or password`() {
        assertEquals("card", SecureVault.kindFor("card_number", "Card number", null))
        assertEquals("card", SecureVault.kindFor("card_expiry", null, "Expiry"))
        assertEquals("password", SecureVault.kindFor("password", "Password", null))
    }

    @Test fun `a name field is a card only when its text names a card or holder`() {
        assertEquals("card", SecureVault.kindFor("name", "Name on card", null))
        assertEquals("card", SecureVault.kindFor("name", null, "Card holder"))
        assertEquals("card", SecureVault.kindFor("name", "持卡人姓名", null))
        assertNull(SecureVault.kindFor("name", "First name", null))
    }

    @Test fun `security codes and profile fields are never offered for saving`() {
        assertNull(SecureVault.kindFor("card_cvc", "Security code", null))
        assertNull(SecureVault.kindFor("otp", "Code", null))
    }

    @Test fun `a password saved from a site gets the site in front of its label`() {
        assertEquals("apple.com password", SecureVault.defaultLabel("Password", null, "password", "apple.com"))
        assertEquals("Password for Apple.com", SecureVault.defaultLabel("Password for Apple.com", null, "password", "apple.com"))
        assertEquals("Card number", SecureVault.defaultLabel("Card number", null, "card_number", "apple.com"))
    }

    // MARK: Migration bookkeeping (pure)

    @Test fun `new rows use the locked key only when the phone can lock`() {
        assertEquals(VaultMigration.LOCKED, VaultMigration.writeVersion(canLock = true))
        assertEquals(VaultMigration.LEGACY, VaultMigration.writeVersion(canLock = false))
    }

    @Test fun `only legacy rows are resealed, and only when the phone can lock`() {
        assertTrue(VaultMigration.needsReseal(VaultMigration.LEGACY, canLock = true))
        assertFalse(VaultMigration.needsReseal(VaultMigration.LEGACY, canLock = false))
        assertFalse(VaultMigration.needsReseal(VaultMigration.LOCKED, canLock = true))
    }

    @Test fun `the legacy key can be retired only when no legacy row is left`() {
        assertTrue(VaultMigration.canRetireLegacy(listOf(VaultMigration.LOCKED, VaultMigration.LOCKED)))
        assertTrue(VaultMigration.canRetireLegacy(emptyList()))
        assertFalse(VaultMigration.canRetireLegacy(listOf(VaultMigration.LOCKED, VaultMigration.LEGACY)))
    }

    // MARK: Storage round trip

    @Test fun `a saved value comes back, is relabelled in place and is deleted`() = runBlocking {
        val s = Setup()
        val id = s.vault.save("4242424242424242", label = "  Visa ending 4242 ", kind = "card", id = "entry-1")
        assertEquals("entry-1", id)
        assertEquals("4242424242424242", s.vault.value("entry-1"))
        assertEquals(listOf(VaultEntry("entry-1", "Visa ending 4242", "card")), s.vault.entries())

        assertEquals("entry-1", s.vault.save("4242424242424242", label = "Work Visa", kind = "card", id = "entry-1"))
        assertEquals(listOf("Work Visa"), s.vault.entries().map { it.label })

        s.vault.delete("entry-1")
        assertNull(s.vault.value("entry-1"))
        assertTrue(s.vault.entries().isEmpty())
    }

    @Test fun `values are encrypted on disk and bound to their id`() = runBlocking {
        val s = Setup()
        s.vault.save("hunter2-secret", label = "Forum", kind = "password", id = "pw-1")
        val onDisk = folder.root.resolve(SecureVault.FILE_NAME).readText()
        assertFalse(onDisk.contains("hunter2-secret"))
        assertTrue(onDisk.contains("Forum"))

        // A row moved under another id must not decrypt: the id is the AAD.
        val moved = onDisk.replace("\"pw-1\"", "\"pw-2\"")
        folder.root.resolve(SecureVault.FILE_NAME).writeText(moved)
        assertNull(vault(s.keys, s.gate).value("pw-2"))
    }

    @Test fun `entries are sorted by label, ignoring case`() = runBlocking {
        val s = Setup()
        s.vault.save("a", label = "banana", kind = "other", id = "1")
        s.vault.save("b", label = "Apple", kind = "password", id = "2")
        s.vault.save("c", label = "cherry", kind = "card", id = "3")
        assertEquals(listOf("Apple", "banana", "cherry"), s.vault.entries().map { it.label })
    }

    @Test fun `refused labels and kinds save nothing`() = runBlocking {
        val s = Setup()
        assertNull(s.vault.save("123", label = "Card CVC", kind = "card"))
        assertNull(s.vault.save("x", label = "   ", kind = "other"))
        assertNull(s.vault.save("x", label = "Thing", kind = "code"))
        assertNull(s.vault.save("", label = "Thing", kind = "other"))
        assertTrue(s.vault.entries().isEmpty())
    }

    // MARK: Authentication window

    @Test fun `many reads inside one window prompt once, and listing never prompts`() = runBlocking {
        val s = Setup()
        s.vault.save("one", label = "A", kind = "other", id = "a")
        s.vault.save("two", label = "B", kind = "other", id = "b")
        s.vault.save("three", label = "C", kind = "other", id = "c")
        assertEquals("the first save is the only prompt so far", 1, s.gate.purposes.size)

        now = 10_000
        assertEquals("one", s.vault.value("a"))
        assertEquals("two", s.vault.value("b"))
        assertEquals("three", s.vault.value("c"))
        s.vault.save("four", label = "D", kind = "other", id = "d")
        s.vault.entries()
        assertEquals("N reads and a save inside the window add no prompt", 1, s.gate.purposes.size)
    }

    @Test fun `after the window closes the next use prompts once and then reads on`() = runBlocking {
        val s = Setup()
        s.vault.save("one", label = "A", kind = "other", id = "a")
        s.vault.save("two", label = "B", kind = "other", id = "b")
        assertEquals(1, s.gate.purposes.size)

        now = WINDOW_MS
        assertEquals("one", s.vault.value("a"))
        assertEquals("the expired window is re-prompted once", 2, s.gate.purposes.size)
        assertEquals("two", s.vault.value("b"))
        assertEquals(2, s.gate.purposes.size)
    }

    @Test fun `a cancelled prompt after expiry gives nothing and the next use asks again`() = runBlocking {
        val s = Setup()
        s.vault.save("one", label = "A", kind = "other", id = "a")
        now = WINDOW_MS
        s.gate.allow = false
        assertNull(s.vault.value("a"))
        assertEquals(2, s.gate.purposes.size)

        s.gate.allow = true
        assertEquals("one", s.vault.value("a"))
        assertEquals(3, s.gate.purposes.size)
    }

    @Test fun `a prompt that does not open the window is not retried in a loop`() = runBlocking {
        val s = Setup()
        s.vault.save("one", label = "A", kind = "other", id = "a")
        now = WINDOW_MS
        s.gate.opensWindow = false
        assertNull(s.vault.value("a"))
        assertEquals("one prompt, one retry, then give up", 2, s.gate.purposes.size)
    }

    @Test fun `a cancelled save stores nothing`() = runBlocking {
        val s = Setup()
        s.gate.allow = false
        assertNull(s.vault.save("value", label = "Thing", kind = "other", id = "t"))
        assertTrue(s.vault.entries().isEmpty())
    }

    @Test fun `a phone without a lock keeps the old behaviour and says so`() = runBlocking {
        val keys = SoftwareKeys(canLock = false, clock = { now }, legacy = null)
        val gate = CountingGate(keys)
        val vault = vault(keys, gate)
        assertFalse(vault.isLocked)
        vault.save("value", label = "Thing", kind = "other", id = "t")
        assertEquals("value", vault.value("t"))
        assertTrue(gate.purposes.isEmpty())
        assertFalse(keys.retired)
    }

    // MARK: Migration from the legacy key

    @Test fun `one authorised pass moves every legacy row with a single prompt and retires the old key`() = runBlocking {
        val legacyKeys = SoftwareKeys(canLock = false, clock = { now }, legacy = null)
        val before = vault(legacyKeys, CountingGate(legacyKeys))
        before.save("first-secret", label = "Card A", kind = "card", id = "a")
        before.save("second-secret", label = "Card B", kind = "card", id = "b")
        before.save("third-secret", label = "Card C", kind = "card", id = "c")
        assertFalse(legacyKeys.retired)

        // The phone gets a lock: the same software keys, now with the locked key available.
        legacyKeys.canLock = true
        val gate = CountingGate(legacyKeys)
        val after = vault(legacyKeys, gate)
        assertEquals("first-secret", after.value("a"))
        assertEquals("one prompt for the whole pass", 1, gate.purposes.size)
        assertTrue(legacyKeys.retired)
        assertEquals("second-secret", after.value("b"))
        assertEquals("third-secret", after.value("c"))
        assertEquals(1, gate.purposes.size)
    }

    @Test fun `a cancelled migration keeps the legacy rows and the old key until a later authorised use`() = runBlocking {
        val legacyKeys = SoftwareKeys(canLock = false, clock = { now }, legacy = null)
        vault(legacyKeys, CountingGate(legacyKeys)).save("secret", label = "Card", kind = "card", id = "a")

        legacyKeys.canLock = true
        val gate = CountingGate(legacyKeys)
        gate.allow = false
        val vault = vault(legacyKeys, gate)
        assertNull(vault.value("a"))
        assertFalse(legacyKeys.retired)
        assertEquals(listOf(VaultEntry("a", "Card", "card")), vault.entries())

        gate.allow = true
        assertEquals("secret", vault.value("a"))
        assertTrue(legacyKeys.retired)
    }

    @Test fun `a saved row that predates the version field reads as legacy`() = runBlocking {
        val legacyKeys = SoftwareKeys(canLock = false, clock = { now }, legacy = null)
        vault(legacyKeys, CountingGate(legacyKeys)).save("old", label = "Old", kind = "other", id = "o")
        // Rows written before the lock have no keyVersion at all.
        val file = folder.root.resolve(SecureVault.FILE_NAME)
        file.writeText(file.readText().replace(Regex(""","keyVersion":\d"""), ""))

        legacyKeys.canLock = true
        assertEquals("old", vault(legacyKeys, CountingGate(legacyKeys)).value("o"))
        assertTrue(legacyKeys.retired)
    }

    // MARK: Keystore invalidation

    @Test fun `a key the Keystore dropped takes its rows with it, and the user is told once`() = runBlocking {
        val s = Setup()
        s.vault.save("4111111111111111", label = "Visa", kind = "card", id = "c")
        s.keys.invalidated = true

        assertNull(s.vault.value("c"))
        assertTrue(s.vault.takeInvalidation())
        assertFalse(s.vault.takeInvalidation())
        assertTrue(s.vault.entries().isEmpty())

        // The phone carries on with a fresh key: a new value can be saved and read back.
        assertEquals("n", s.vault.save("4000000000000002", label = "New card", kind = "card", id = "n"))
        assertEquals("4000000000000002", s.vault.value("n"))
    }
}
