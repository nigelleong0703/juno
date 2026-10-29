package io.github.nigelleong0703.juno.ui.onboarding

import android.content.Context

/** Whether the first-run carousel was seen (iOS `onboardingSeen`). App-private, reset by reinstalling, as on iOS. */
class OnboardingStore(context: Context) {
    private val prefs = context.getSharedPreferences("juno.onboarding", Context.MODE_PRIVATE)

    fun isSeen(): Boolean = prefs.getBoolean(KEY, false)

    fun markSeen() {
        prefs.edit().putBoolean(KEY, true).apply()
    }

    private companion object { const val KEY = "seen" }
}
