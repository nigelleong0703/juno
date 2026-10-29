package io.github.nigelleong0703.juno.ui.agents.takeover

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color as AndroidColor
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * Talks to the noVNC page in a [LiveScreenView]. The page exposes `window.juno` (see [page]); this class only
 * serialises calls, so every argument is passed as JSON and nothing is spliced into the script as text.
 */
class ScreenControl {
    internal var web: WebView? = null

    private fun call(fn: String, vararg args: Any) {
        val web = web ?: return
        val json = JsonArray(args.map { a ->
            when (a) { is String -> JsonPrimitive(a); is Boolean -> JsonPrimitive(a); is Int -> JsonPrimitive(a); is Number -> JsonPrimitive(a.toDouble()); else -> JsonPrimitive(a.toString()) }
        }).toString()
        web.evaluateJavascript("window.juno && window.juno.$fn.apply(null, $json)", null)
    }

    /** Typed text, as key presses on the remote computer (characters outside Latin-1 use the Unicode keysym range). */
    fun text(value: String) = call("text", value)
    /** One key press by X11 keysym (0xFF0D Return, 0xFF08 Backspace, 0xFF09 Tab, 0xFF1B Escape). */
    fun key(keysym: Int) = call("key", keysym)
    /** Ctrl+C on the remote; the copied text comes back on the clipboard callback. */
    fun copy() = call("copy")
    /** Puts text on the remote clipboard, then Ctrl+V into the focused field. */
    fun paste(value: String) = call("paste", value)
    /** Ctrl+V on the remote alone: an image or files already put on its clipboard through the side channel. */
    fun pressPaste() = call("pressPaste")
    /** Pointer state on the remote, in framebuffer pixels; [buttons] is the RFB mask (1 left, 2 middle, 4 right). */
    fun pointer(at: Pt, buttons: Int) = call("pointer", at.x, at.y, buttons)
    /** One wheel notch (RFB button bit 3 up, 4 down, 5 left, 6 right) at that position. */
    fun wheel(at: Pt, bit: Int) = call("wheel", at.x, at.y, bit)
    /** Zoom and pan of the picture, and the cursor drawn in page points (touch has no hover cursor of its own). */
    fun view(zoom: Float, offset: Pt, cursor: Pt, showCursor: Boolean) = call("view", zoom, offset.x, offset.y, cursor.x, cursor.y, showCursor)
    /** Asks the page to report its layout again (when a touch surface attaches after the stream is up). */
    fun requestLayout() = call("layout")

    /** Set by the touch surface: the remote size, where the page drew it, and the page size. */
    var onLayout: ((Sz, Rc, Sz) -> Unit)? = null

    internal fun layoutChanged(json: String) {
        val a = runCatching { Json.parseToJsonElement(json).jsonArray.map { it.jsonPrimitive.doubleOrNull?.toFloat() ?: return } }.getOrNull() ?: return
        if (a.size != 8) return
        onLayout?.invoke(Sz(a[0], a[1]), Rc(a[2], a[3], a[4], a[5]), Sz(a[6], a[7]))
    }
}

/** Page -> native messages arrive on a WebView thread; callbacks run on the main thread. */
private class Bridge(val onState: () -> ((String) -> Unit), val onClipboard: () -> ((String) -> Unit), val control: () -> ScreenControl?) {
    private val main = Handler(Looper.getMainLooper())
    @JavascriptInterface fun state(s: String) { main.post { onState()(s) } }
    @JavascriptInterface fun clipboard(s: String) { main.post { onClipboard()(s) } }
    @JavascriptInterface fun layout(s: String) { main.post { control()?.layoutChanged(s) } }
}

/**
 * The agent's live screen: the web app's noVNC client (bundled asset `novnc.js`, same build as iOS) in a WebView,
 * dialled to the signed `/v1/screens/:id/vnc` ticket ([url] is already validated and host-pinned). Touches are not
 * handled by the page: [PointerSurface] sits on top and drives the mouse through [ScreenControl].
 * [onState] gets "connected" or anything else for a stream that is gone.
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
@Composable
fun LiveScreenView(
    url: String,
    viewOnly: Boolean,
    onState: (String) -> Unit,
    modifier: Modifier = Modifier,
    control: ScreenControl? = null,
    onClipboard: (String) -> Unit = {},
) {
    val state by rememberUpdatedState(onState)
    val clip by rememberUpdatedState(onClipboard)
    val ctl by rememberUpdatedState(control)
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(AndroidColor.BLACK)
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                overScrollMode = WebView.OVER_SCROLL_NEVER
                // Only the bundled page runs here: no file or content access, and no navigation away from it.
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
                }
                addJavascriptInterface(Bridge({ state }, { clip }, { ctl }), "JunoBridge")
            }
        },
        update = { web ->
            ctl?.web = web
            if (web.tag != url to viewOnly) {
                web.tag = url to viewOnly
                web.loadDataWithBaseURL(baseFor(url), page(web.context, url, viewOnly), "text/html", "utf-8", null)
            }
        },
        onRelease = { web ->
            web.evaluateJavascript("window.rfb && window.rfb.disconnect()", null)
            web.removeJavascriptInterface("JunoBridge")
            if (ctl?.web === web) ctl?.web = null
            web.destroy()
        },
    )
}

/** The page's origin must match the socket's security: an https page may not open ws:// (mixed content), which is what a LAN or local server hands out. */
private fun baseFor(url: String) = if (url.startsWith("wss:")) "https://juno.local/" else "http://juno.local/"

private var novncSource: String? = null

private fun novnc(context: Context): String =
    novncSource ?: context.assets.open("novnc.js").bufferedReader().use { it.readText() }.also { novncSource = it }

private fun page(context: Context, url: String, viewOnly: Boolean): String {
    val target = JsonPrimitive(url).toString()
    return """
    <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
    <style>html,body,#z,#s{margin:0;width:100%;height:100%;background:#000;overflow:hidden;touch-action:none}
    #z{transform-origin:0 0}
    #c{position:absolute;left:0;top:0;width:22px;height:30px;margin:0;pointer-events:none;display:none;transform-origin:0 0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.7))}</style></head>
    <body><div id="z"><div id="s"></div>
    <svg id="c" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18.5 L12.5 28 L16 26.5 L11.7 17.3 L19.5 17 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
    <script type="module">${novnc(context)}
    const post = (s) => window.JunoBridge.state(s);
    try {
      const rfb = new window.RFB(document.getElementById('s'), $target, { shared: true, wsProtocols: ['binary'] });
      rfb.viewOnly = $viewOnly;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = '#000';
      rfb.addEventListener('connect', () => post('connected'));
      rfb.addEventListener('disconnect', (e) => post(e.detail && e.detail.clean ? 'closed' : 'dropped'));
      rfb.addEventListener('securityfailure', () => post('dropped'));
      rfb.addEventListener('clipboard', (e) => window.JunoBridge.clipboard(e.detail.text));
      window.rfb = rfb;
      const ctrlChord = (keysym, code) => {
        rfb.sendKey(0xFFE3, 'ControlLeft', true);
        rfb.sendKey(keysym, code);
        rfb.sendKey(0xFFE3, 'ControlLeft', false);
      };
      // Pointer input comes from PointerSurface in framebuffer pixels. _sendMouse takes canvas pixels and divides by
      // the display scale again, so scale first (the +.25 keeps float error from truncating to the pixel before).
      const disp = rfb._display;
      const mouse = (fx, fy, mask) => rfb._sendMouse((Math.round(fx) + 0.25) * disp.scale, (Math.round(fy) + 0.25) * disp.scale, mask);
      const zoomEl = document.getElementById('z'), cur = document.getElementById('c');
      let view = { z: 1, x: 0, y: 0 }, cursor = { x: 0, y: 0, show: false };
      const paint = () => {
        zoomEl.style.transform = `translate(${'$'}{view.x}px,${'$'}{view.y}px) scale(${'$'}{view.z})`;
        cur.style.display = cursor.show ? 'block' : 'none';
        cur.style.transform = `translate(${'$'}{cursor.x}px,${'$'}{cursor.y}px) scale(${'$'}{1 / view.z})`;
      };
      // Where the canvas sits at zoom 1 (undo the current transform), for the touch surface's maths.
      const layout = () => {
        const cv = rfb._canvas, r = cv.getBoundingClientRect();
        if (!cv.width || !r.width) return;
        window.JunoBridge.layout(JSON.stringify([cv.width, cv.height,
          (r.left - view.x) / view.z, (r.top - view.y) / view.z, r.width / view.z, r.height / view.z, innerWidth, innerHeight]));
      };
      rfb.addEventListener('connect', () => setTimeout(layout, 50));
      rfb.addEventListener('desktopsize', () => setTimeout(layout, 50));
      addEventListener('resize', () => setTimeout(layout, 50));
      window.juno = {
        text(s) { for (const ch of s) { const cp = ch.codePointAt(0); rfb.sendKey(cp < 0x100 ? cp : 0x01000000 + cp, null); } },
        key(keysym) { rfb.sendKey(keysym, null); },
        copy() { ctrlChord(0x63, 'KeyC'); },
        paste(s) { rfb.clipboardPasteFrom(s); ctrlChord(0x76, 'KeyV'); },
        pressPaste() { ctrlChord(0x76, 'KeyV'); },
        pointer(fx, fy, buttons) { mouse(fx, fy, buttons); },
        wheel(fx, fy, bit) { mouse(fx, fy, 1 << bit); mouse(fx, fy, 0); },
        view(z, x, y, cx, cy, show) { view = { z, x, y }; cursor = { x: cx, y: cy, show }; paint(); },
        layout
      };
    } catch (e) { post('dropped'); }
    </script></body></html>
    """
}
