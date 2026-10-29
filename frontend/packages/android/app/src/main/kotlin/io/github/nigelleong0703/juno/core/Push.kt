package io.github.nigelleong0703.juno.core

/**
 * TODO(push): port Core/Push.swift (FCM registration, local notices for `run.finished` / `request.created`).
 * The World calls this seam on sign-in/out; the default does nothing so the rest of the app is unaffected.
 */
interface PushRegistrar {
    fun signedIn(api: Api) {}
    fun signingOut() {}
    /** Ask for the notification permission at the first moment it helps (see iOS `World.askForNotifications`). */
    fun askForPermission() {}

    object None : PushRegistrar
}
