package io.github.nigelleong0703.juno.ui.components

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Opens a link in whatever app handles it (a plain ACTION_VIEW: no Custom Tabs, no in-app browser). [webOnly] limits it
 * to http(s) links, for links taken from content. Returns false when nothing was opened (not allowed, or no app).
 */
fun Context.openLink(url: String, webOnly: Boolean = false, newTask: Boolean = false): Boolean {
    if (webOnly && !url.startsWith("https://") && !url.startsWith("http://")) return false
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
    if (newTask) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
        startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}

/**
 * Opens a sign-in page in the browser. Custom Tabs have no completion callback, so a sign-in is not watched: the lists
 * re-read on resume instead, and a cancelled sign-in is simply no change. Throws when no browser can open it, so the
 * sheet that asked can say so.
 */
fun Context.openSignInPage(url: String) {
    if (!openLink(url, newTask = true)) throw IllegalStateException("No browser can open this page.")
}

/** The host of a link without `www.` ("Source: example.com"), or the link itself when it has no host. */
fun sourceHost(url: String): String {
    val host = runCatching { Uri.parse(url).host }.getOrNull()
    return host?.removePrefix("www.") ?: url
}
