package io.github.nigelleong0703.juno.core

import android.content.Context
import android.content.ContextWrapper
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** The activity that hosts this context (Compose hands out a wrapped context), or null outside one. */
fun Context.findFragmentActivity(): FragmentActivity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is FragmentActivity) return current
        current = current.baseContext
    }
    return current as? FragmentActivity
}

/**
 * Shows the system BiometricPrompt. It has no CryptoObject: the locked key is time-bound, so a successful authentication
 * opens the key for [VaultKeys.WINDOW_SECONDS] and the next cipher init succeeds. A cancel, a failure or no enrolled lock
 * gives false.
 */
class BiometricVaultGate(private val activity: FragmentActivity) : VaultAccessGate {
    override suspend fun authenticate(purpose: String): Boolean = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { continuation ->
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (continuation.isActive) continuation.resume(true)
                    }

                    // A wrong finger is reported through onAuthenticationFailed and the prompt stays up; errors end it.
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (continuation.isActive) continuation.resume(false)
                    }
                },
            )
            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
            prompt.authenticate(promptInfo(purpose))
        }
    }

    private fun promptInfo(purpose: String): BiometricPrompt.PromptInfo {
        val authenticators = VaultAuthenticators.prompt
        val builder = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock your saved details")
            .setSubtitle(purpose)
            .setAllowedAuthenticators(authenticators)
        // A device-credential prompt has its own cancel control; a biometric-only one needs a button.
        if (authenticators and BiometricManager.Authenticators.DEVICE_CREDENTIAL == 0) builder.setNegativeButtonText("Cancel")
        return builder.build()
    }
}
