package io.github.nigelleong0703.juno.ui.agents.takeover

import android.content.Context
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/** X11 keysyms the remote understands (iOS `KeyInputView`). */
object Keysym {
    const val BACKSPACE = 0xFF08
    const val TAB = 0xFF09
    const val RETURN = 0xFF0D
    const val ESCAPE = 0xFF1B
    const val LEFT = 0xFF51
    const val UP = 0xFF52
    const val RIGHT = 0xFF53
    const val DOWN = 0xFF54

    /** Typed text as runs of characters and the Return/Tab keys between them, so the remote gets key presses in order. */
    fun split(text: String): List<Any> {
        val out = ArrayList<Any>()
        val run = StringBuilder()
        fun flush() { if (run.isNotEmpty()) { out += run.toString(); run.clear() } }
        for (ch in text) when (ch) {
            '\n', '\r' -> { flush(); out += RETURN }
            '\t' -> { flush(); out += TAB }
            else -> run.append(ch)
        }
        flush()
        return out
    }
}

/**
 * An invisible focused view that turns the Android keyboard into key presses on the remote computer. Committed text
 * only: IME composition (CJK pinyin etc.) is not forwarded until it commits. Plain-text traits (no suggestions,
 * autocorrect or capitals) so typed characters reach the remote as typed.
 */
private class KeyInputView(context: Context, var onText: (String) -> Unit, var onKey: (Int) -> Unit) : View(context) {
    init { isFocusable = true; isFocusableInTouchMode = true }

    override fun onCheckIsTextEditor() = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
        return object : BaseInputConnection(this, false) {
            override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                for (part in Keysym.split(text.toString())) if (part is String) onText(part) else onKey(part as Int)
                return true
            }
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                repeat(beforeLength.coerceAtLeast(1)) { onKey(Keysym.BACKSPACE) }
                return true
            }
            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) keysym(event.keyCode)?.let(onKey)
                return true
            }
            override fun performEditorAction(actionCode: Int): Boolean { onKey(Keysym.RETURN); return true }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val sym = keysym(keyCode) ?: return super.onKeyDown(keyCode, event)
        onKey(sym)
        return true
    }

    private fun keysym(keyCode: Int): Int? = when (keyCode) {
        KeyEvent.KEYCODE_DEL -> Keysym.BACKSPACE
        KeyEvent.KEYCODE_ENTER -> Keysym.RETURN
        KeyEvent.KEYCODE_TAB -> Keysym.TAB
        KeyEvent.KEYCODE_ESCAPE -> Keysym.ESCAPE
        KeyEvent.KEYCODE_DPAD_LEFT -> Keysym.LEFT
        KeyEvent.KEYCODE_DPAD_RIGHT -> Keysym.RIGHT
        KeyEvent.KEYCODE_DPAD_UP -> Keysym.UP
        KeyEvent.KEYCODE_DPAD_DOWN -> Keysym.DOWN
        else -> null
    }
}

/** Zero-size keyboard catcher: the soft keyboard is up exactly while [active]. */
@Composable
fun KeyCatcher(active: Boolean, onText: (String) -> Unit, onKey: (Int) -> Unit, modifier: Modifier = Modifier) {
    val text by rememberUpdatedState(onText)
    val key by rememberUpdatedState(onKey)
    AndroidView(
        modifier = modifier,
        factory = { KeyInputView(it, { s -> text(s) }, { k -> key(k) }) },
        update = { view ->
            val imm = view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            if (active) {
                view.requestFocus()
                view.post { imm.showSoftInput(view, 0) }
            } else {
                imm.hideSoftInputFromWindow(view.windowToken, 0)
                view.clearFocus()
            }
        },
    )
}
