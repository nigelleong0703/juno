package io.github.nigelleong0703.juno.ui.chat.secure

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.nigelleong0703.juno.contract.SealedSecureValue
import io.github.nigelleong0703.juno.contract.SecureInputEncryption
import io.github.nigelleong0703.juno.contract.SecureInputField
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.SecureVault
import io.github.nigelleong0703.juno.core.SecureSeal
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.SecureKind
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.sealSecureFields
import io.github.nigelleong0703.juno.state.submitSecureInput
import io.github.nigelleong0703.juno.state.syncVaultKeys
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * A value the user chose to keep on this phone once the page has taken it. [replaces] is the entry the field was filled
 * from, so saving again updates that entry instead of adding a copy.
 */
data class VaultKeep(val label: String, val kind: String, val value: String, val replaces: String?)

/**
 * The open secure-input sheet's values and send state (iOS `SecureInputSheet`'s @State). It lives in this composition only:
 * nothing is persisted or logged, and [clear] runs when the sheet goes away.
 */
class SecureFormState(
    /** False when the phone has no lock: saved details are then not behind the user's authentication (the sheet says so). */
    val vaultLocked: Boolean = true,
) {
    val values = mutableStateMapOf<String, String>()
    val touched = mutableStateMapOf<String, Boolean>()
    val revealed = mutableStateMapOf<String, Boolean>()
    val vaultFilled = mutableStateMapOf<String, Boolean>()
    val saveOn = mutableStateMapOf<String, Boolean>()
    val labels = mutableStateMapOf<String, String>()
    /** Field id -> the vault entry it was filled from: saving again replaces that entry instead of adding a copy. */
    val filledFrom = mutableStateMapOf<String, String>()
    var busy by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    var needsHandBack by mutableStateOf(false)

    /** Sealed values kept while the user holds the screen (409 USER_CONTROL): sent again once it is handed back. */
    var held: Map<String, SealedSecureValue>? = null
    var toSave: List<VaultKeep> = emptyList()

    fun clear() {
        values.clear()
        held = null
        toSave = emptyList()
    }

    /** Typing: formatted as the field kind says, and marks the field as touched so its error shows. */
    fun type(field: SecureInputField, raw: String) {
        val clean = SecureKind.sanitize(field, raw)
        if (values[field.id] == clean) return
        values[field.id] = clean
        touched[field.id] = true
        message = null
    }

    /** The vault kind a field may be saved as, or null when it is never offered (CVC, one-time codes, profile details). */
    fun vaultKind(field: SecureInputField): String? =
        SecureVault.kindFor(SecureKind.resolve(field), field.label, null)

    /** Off until the user switches it on: nothing is kept unless they say so (a password included). */
    fun saves(field: SecureInputField): Boolean = vaultKind(field) != null && saveOn[field.id] == true

    fun labelFor(field: SecureInputField, site: String?): String =
        labels[field.id] ?: SecureVault.defaultLabel(field.label, null, SecureKind.resolve(field), site)

    /** The message under a field: its own rule once touched, else the server's failure for it. */
    fun errorFor(field: SecureInputField): String? {
        if (touched[field.id] == true) SecureKind.validate(field, values[field.id].orEmpty())?.let { return it }
        return if (field.status == SecureInputField.StatusValue.failed) "Could not fill this field" else null
    }

    fun isReady(fields: List<SecureInputField>, site: String?): Boolean =
        fields.isNotEmpty() && fields.all { field ->
            SecureKind.validate(field, values[field.id].orEmpty()) == null &&
                (!saves(field) || SecureVault.labelProblem(labelFor(field, site)) == null)
        }

    /**
     * Fills the fields whose `vaultId` names an entry this phone holds (iOS `prefillFromVault`). The values stay in this
     * composition; a field the user already typed into is left alone.
     */
    suspend fun prefillFromVault(world: World, vault: SecureVault, fields: List<SecureInputField>) {
        val heldIds = withContext(Dispatchers.IO) { vault.entries().map { it.id }.toSet() }
        val matches = fields.filter { vaultKind(it) != null && it.vaultId != null && it.vaultId in heldIds && values[it.id] == null }
        if (matches.isEmpty()) return
        // The first read prompts once; the rest of the fields are read inside the same window without a prompt.
        for (field in matches) {
            // A cancelled prompt leaves that field empty.
            val value = vault.value(field.vaultId!!) ?: continue
            val options = field.options.orEmpty()
            if (options.isNotEmpty() && value !in options) continue
            values[field.id] = SecureKind.sanitize(field, value)
            vaultFilled[field.id] = true
            filledFrom[field.id] = field.vaultId!!
        }
        if (vault.takeInvalidation()) {
            // The Keystore dropped the key (a new fingerprint was enrolled): those values are gone for good.
            message = "Saved details on this phone were cleared because your fingerprints or lock changed. Enter them again."
            withContext(Dispatchers.IO) { world.syncVaultKeys(vault.entries()) }
        }
    }

    /**
     * Seals and posts the form (iOS `submit` and `send`). True when every value was accepted and the sheet may close.
     * A 409 `USER_CONTROL` keeps the sealed values in [held] and asks for the screen back.
     */
    suspend fun send(
        world: World,
        vault: SecureVault,
        requestId: String,
        fields: List<SecureInputField>,
        encryption: SecureInputEncryption?,
        site: String?,
    ): Boolean {
        busy = true
        message = null
        needsHandBack = false
        var sealed: Map<String, SealedSecureValue>? = null
        try {
            val toSend = held ?: run {
                val sent = SecureKind.outputs(fields, values.toMap())
                toSave = fields.mapNotNull { field ->
                    val value = sent[field.id] ?: return@mapNotNull null
                    val kind = vaultKind(field) ?: return@mapNotNull null
                    if (!saves(field)) return@mapNotNull null
                    VaultKeep(labelFor(field, site), kind, value, replaces = filledFrom[field.id])
                }
                sealSecureFields(fields, sent, encryption, requestId)
            }
            sealed = toSend
            val results = world.submitSecureInput(requestId, toSend)
            held = null
            val failed = results.filter { it.status == "failed" }
            if (failed.isEmpty()) {
                // The page already has the values: a failed vault write must not read as a failed send.
                try {
                    saveToVault(world, vault)
                } catch (e: Throwable) {
                    if (e.isCancellation) throw e
                }
                return true
            }
            message = failed.joinToString(" ") { f -> "Could not fill ${fields.firstOrNull { it.id == f.id }?.label ?: f.id}." }
        } catch (e: ApiException.Api) {
            when {
                e.status == 409 && e.code == "USER_CONTROL" -> {
                    held = sealed
                    needsHandBack = true
                    message = "You still have control of the screen. Hand it back, then try again."
                }
                e.status == 409 && e.code == "ENCRYPTION_UNAVAILABLE" -> message = SecureSeal.OlderComputer().message
                else -> message = e.userMessage
            }
        } catch (e: SecureSeal.OlderComputer) {
            message = e.message
        } catch (e: Throwable) {
            if (!e.isCancellation) message = e.userMessage
        } finally {
            busy = false
        }
        return false
    }

    /** Keeps the chosen details once the page took them. A value filled from an entry replaces that entry. */
    private suspend fun saveToVault(world: World, vault: SecureVault) {
        val keep = toSave
        toSave = emptyList()
        if (keep.isEmpty()) return
        // Each save may prompt for authentication. A cancelled one keeps nothing; the send itself already succeeded.
        for (item in keep) {
            vault.save(item.value, item.label, item.kind, item.replaces ?: UUID.randomUUID().toString())
        }
        withContext(Dispatchers.IO) { world.syncVaultKeys(vault.entries()) }
    }
}
