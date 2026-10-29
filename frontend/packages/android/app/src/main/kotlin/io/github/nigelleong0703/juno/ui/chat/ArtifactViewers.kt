package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import io.github.nigelleong0703.juno.ui.components.ButtonSize
import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import io.github.nigelleong0703.juno.ui.theme.SystemBarIcons
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.RenderUrl
import io.github.nigelleong0703.juno.state.artifactRenderUrl
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.ui.components.BytesImage
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.time.Instant

/** The result of an artifact fetch: loading, failed (with Retry) or ready. */
sealed interface Loaded<out T> { data object Loading : Loaded<Nothing>; data object Failed : Loaded<Nothing>; data class Ready<T>(val value: T) : Loaded<T> }

/**
 * The sandboxed page of an HTML artifact (iOS `PublishedArtifact.swift:167-207`): JS on, no storage or cookies, no file
 * access, no new windows, navigation only within the signed render URL's origin. The render URL is fetched per version
 * and re-requested when it expires in under 60 s. [reload] bumps to retry.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun SandboxedPage(artifactId: String, version: Int, modifier: Modifier = Modifier) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    var attempt by remember { mutableIntStateOf(0) }
    var pageFailed by remember(artifactId, version) { mutableStateOf(false) }
    val url by produceState<Loaded<RenderUrl>>(Loaded.Loading, artifactId, version, attempt) {
        value = Loaded.Loading
        value = try {
            var fresh = world.artifactRenderUrl(artifactId, version)
            // A signed address that expires in under 60 s is requested again before the page loads.
            if (parseIso(fresh.expiresAt)?.let { it.epochSecond - Instant.now().epochSecond < 60 } == true) fresh = world.artifactRenderUrl(artifactId, version)
            Loaded.Ready(fresh)
        } catch (e: Throwable) { if (e.isCancellation) throw e; Loaded.Failed }
    }
    Box(modifier.background(c.card)) {
        when (val u = url) {
            Loaded.Loading -> Text("Loading…", color = c.fgSubtle, style = junoText(TextSize.Sm), modifier = Modifier.align(Alignment.Center))
            Loaded.Failed -> LoadError("Couldn't load this page.") { attempt++ }
            is Loaded.Ready -> if (pageFailed) LoadError("Couldn't load this page.") { pageFailed = false; attempt++ } else {
                val origin = remember(u.value.url) { android.net.Uri.parse(u.value.url).let { "${it.scheme}://${it.authority}" } }
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx -> WebView(ctx).apply { layoutParams = ViewGroup.LayoutParams(-1, -1); configure(origin) { pageFailed = true } } },
                    update = { web -> if (web.url != u.value.url) web.loadUrl(u.value.url) },
                    onRelease = { it.destroy() },
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun WebView.configure(origin: String, onError: () -> Unit) {
    settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = false
        databaseEnabled = false
        allowFileAccess = false
        allowContentAccess = false
        setSupportMultipleWindows(false)
        javaScriptCanOpenWindowsAutomatically = false
        cacheMode = WebSettings.LOAD_NO_CACHE
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    }
    CookieManager.getInstance().apply { setAcceptCookie(false); setAcceptThirdPartyCookies(this@configure, false) }
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val u = request.url
            return "${u.scheme}://${u.authority}" != origin
        }
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) onError()
        }
    }
}

@Composable
private fun LoadError(text: String, retry: () -> Unit) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxSize(), verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, color = c.fgMuted, style = junoText(TextSize.Sm))
        JunoButton("Retry", retry, variant = ButtonVariant.Secondary, size = ButtonSize.Regular)
    }
}

/** A full-screen dialog with a close button, shared by the page and the image viewers. */
@Composable
fun FullScreen(onClose: () -> Unit, content: @Composable () -> Unit) {
    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        // The dialog has its own window: give it the theme's status-bar icons, or they vanish on the canvas.
        SystemBarIcons((LocalView.current.parent as? DialogWindowProvider)?.window, JunoTheme.colors.isDark)
        Box(Modifier.fillMaxSize().background(JunoTheme.colors.canvas)) {
            content()
            Icon(
                JunoIcons.Close, "Close", tint = JunoTheme.colors.fg,
                modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(16.dp).background(JunoTheme.colors.muted, androidx.compose.foundation.shape.CircleShape).clickable(onClick = onClose).padding(8.dp),
            )
        }
    }
}

/** A picture to look at closely: scrollable both ways (iOS `ImageViewer`). Coil downsamples it to the drawn size. */
@Composable
fun ImageViewer(bytes: ByteArray, onClose: () -> Unit) = FullScreen(onClose) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState())) {
        BytesImage(bytes, cacheKey = null, modifier = Modifier.widthIn(min = 600.dp), contentScale = ContentScale.FillWidth)
    }
}

/** An inline picture, at most [maxHeight] tall; [cacheKey] keeps it in Coil's memory cache. */
@Composable
fun InlineImage(bytes: ByteArray, cacheKey: String, maxHeight: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) =
    BytesImage(bytes, cacheKey, modifier.fillMaxWidth().heightIn(max = maxHeight), ContentScale.Fit)
