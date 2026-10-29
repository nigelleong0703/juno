package io.github.nigelleong0703.juno.ui.settings.channels

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context

fun Context.copyText(label: String, text: String) {
    getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, text))
}
