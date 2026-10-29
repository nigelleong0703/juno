package io.github.nigelleong0703.juno.ui.agents.takeover

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import android.content.Context
import android.util.Base64
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.ScreenClipboard
import io.github.nigelleong0703.juno.contract.ScreenClipboardPasteResult
import io.github.nigelleong0703.juno.contract.ScreenElements
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.TakeoverDial
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.copyComputerClipboard
import io.github.nigelleong0703.juno.state.pasteComputerClipboard
import io.github.nigelleong0703.juno.state.refreshScreen
import io.github.nigelleong0703.juno.state.resolve
import io.github.nigelleong0703.juno.state.returnControl
import io.github.nigelleong0703.juno.state.screenElements
import io.github.nigelleong0703.juno.state.stopRun
import io.github.nigelleong0703.juno.state.streamUrl
import io.github.nigelleong0703.juno.state.takeOver
import io.github.nigelleong0703.juno.ui.agents.PictureImage
import io.github.nigelleong0703.juno.ui.agents.rememberPictureSize
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val barFill = Color.White.copy(alpha = 0.12f)

/**
 * Full-screen take-over (iOS `TakeoverView`): dark, the title and the agent's name at the top with a check that hands
 * control back, the live screen right under it, and a control bar (keyboard, trackpad/touch, copy, paste) with a red
 * Stop on its left. [requestId] is the take-over request this opens for: its focus rectangle is zoomed to, and a text
 * field brings the keyboard up. Needs a live server (a control ticket).
 */
@Composable
fun TakeoverScreen(agentId: String, requestId: String?, onClose: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val request = state.request(requestId)
    val focus = request?.payload?.focus
    val focusRect = focus?.rect?.let { r ->
        val w = r.width ?: 0L; val h = r.height ?: 0L
        if (w > 0 && h > 0) Rc((r.x ?: 0L).toFloat(), (r.y ?: 0L).toFloat(), w.toFloat(), h.toFloat()) else null
    }
    val control = remember { ScreenControl() }
    val prefs = remember { context.getSharedPreferences("juno.takeover", Context.MODE_PRIVATE) }
    var directTouch by remember { mutableStateOf(runCatching { prefs.getBoolean("directTouch", false) }.getOrDefault(false)) }
    // With a focused element the keyboard comes up only for a text field; a plain take-over keeps it up.
    var keyboardOn by remember { mutableStateOf(focus == null || isTextRole(focus.role)) }
    var liveUrl by remember { mutableStateOf<String?>(null) }
    var connected by remember { mutableStateOf(false) }
    var dials by remember { mutableIntStateOf(0) }
    val snackbar = remember { SnackbarHostState() }
    var elements by remember { mutableStateOf<ScreenElements?>(null) }
    var refresh by remember { mutableStateOf<Job?>(null) }
    /** The remote's clipboard text from the page's cut-text: the fallback only when the computer cannot answer the clipboard read. */
    var remoteCutText by remember { mutableStateOf<String?>(null) }

    val user = data.computer?.controller == "user"
    val name = state.agent(agentId)?.name ?: "Agent"
    val live = liveUrl != null && connected
    val shot = data.screenshots[agentId]
    val size = rememberPictureSize(shot)
    val activeRun = state.activeRunsOf(agentId).firstOrNull()

    fun flash(text: String) {
        scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(text, duration = SnackbarDuration.Short) }
    }
    fun scheduleElements(after: Long = 700) {
        refresh?.cancel()
        refresh = scope.launch { delay(after); elements = world.screenElements(agentId) }
    }
    /**
     * Copy from computer: Ctrl+C there, then what its clipboard holds comes here. Text goes to this device's clipboard, an image
     * goes as an image, a file is offered to share (which includes saving it). The remote's cut-text answers only when the computer
     * cannot (an older computer without the side channel); a take-over refusal and a too-large item are named, never retried as text.
     */
    fun copyFromComputer() {
        remoteCutText = null
        control.copy()
        scope.launch {
            delay(350)
            try {
                val copied = world.copyComputerClipboard(agentId)
                when (copied.kind) {
                    ScreenClipboard.KindValue.text -> {
                        context.putTextOnClipboard(copied.text.orEmpty())
                        flash("Copied from the computer")
                    }
                    ScreenClipboard.KindValue.image -> {
                        context.putImageOnClipboard(Base64.decode(copied.contentBase64.orEmpty(), Base64.DEFAULT))
                        flash("Image copied from the computer")
                    }
                    ScreenClipboard.KindValue.file -> {
                        context.shareComputerFile(copied.name ?: "file", Base64.decode(copied.contentBase64.orEmpty(), Base64.DEFAULT))
                    }
                    else -> flash("Nothing selected on the computer — select something there first")
                }
            } catch (e: Throwable) {
                if (e.isCancellation) throw e
                val status = (e as? ApiException)?.httpStatus
                val cut = remoteCutText
                if (cut != null && status != 409 && status != 413) {
                    context.putTextOnClipboard(cut)
                    flash("Copied from the computer")
                } else {
                    flash(computerClipboardMessage(e))
                }
            }
        }
    }

    /**
     * Paste to computer: files on this device's clipboard go into the computer's Downloads; an image goes onto its clipboard and
     * Ctrl+V pastes it; text keeps the VNC path (the remote clipboard is set, then Ctrl+V).
     */
    fun pasteFromDevice() {
        scope.launch {
            val device = withContext(Dispatchers.IO) { runCatching { readDeviceClipboard(context) }.getOrDefault(DevicePaste.Empty) }
            when (device) {
                is DevicePaste.Text -> control.paste(device.text)
                DevicePaste.Empty -> flash("Nothing to paste on this device")
                DevicePaste.TooLarge -> flash("That is larger than the 10 MB limit")
                is DevicePaste.Send -> try {
                    val result = world.pasteComputerClipboard(agentId, device.input)
                    if (result.kind == ScreenClipboardPasteResult.KindValue.image) {
                        control.pressPaste()
                        flash("Image pasted to the computer")
                    } else {
                        flash("Saved to " + result.saved.orEmpty().mapNotNull { it.path }.joinToString(", "))
                    }
                } catch (e: Throwable) {
                    if (e.isCancellation) throw e
                    flash(computerClipboardMessage(e))
                }
            }
        }
    }
    fun handBack() {
        val hadKeyboard = keyboardOn
        keyboardOn = false
        if (request != null) world.returnControl(request) else world.returnControl(agentId)
        scope.launch { if (hadKeyboard) delay(280); onClose() }
    }
    fun cantHelp() {
        request?.let { world.resolve(it.id, "denied") }
        keyboardOn = false
        world.returnControl(agentId)
        onClose()
    }

    DarkSystemBars()
    // Hide the keyboard flag when the user dismisses it with the system gesture.
    val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    var imeWasVisible by remember { mutableStateOf(false) }
    LaunchedEffect(imeVisible) {
        if (imeVisible) imeWasVisible = true else if (imeWasVisible) { imeWasVisible = false; keyboardOn = false }
    }

    LaunchedEffect(agentId) { world.refreshScreen(agentId) }
    // Taking over: wait until the server has switched the screen to the user, then dial a control ticket (one asked
    // for earlier is view-only and drops every click). A dropped stream re-dials.
    LaunchedEffect(dials) {
        TakeoverDial.run({ world.takeOver(agentId) }, { world.streamUrl(agentId, control = true) })?.let { liveUrl = it }
    }
    // Tap targets need the user in control: ask once the control stream is up.
    LaunchedEffect(liveUrl, directTouch) { if (liveUrl != null && directTouch) scheduleElements(300) }
    DisposableEffect(Unit) { onDispose { refresh?.cancel() } }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(96.dp)) {
                    if (request?.status == "pending") {
                        Text("Can't help", style = junoText(TextSize.Base, FontWeight.Medium), color = Color.White, modifier = Modifier.clip(CircleShape).clickable { cantHelp() }.padding(8.dp))
                    }
                }
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(if (user) "You're in control" else "Taking control…", style = junoText(TextSize.Md, FontWeight.SemiBold), color = Color.White)
                    // No browser tab title in the computer state yet: the agent's name stands in.
                    Text(name, style = junoText(TextSize.Xs), color = Color.White.copy(alpha = 0.55f), maxLines = 1)
                }
                Box(Modifier.width(96.dp), contentAlignment = Alignment.CenterEnd) {
                    IconButton({ handBack() }) { Icon(JunoIcons.Check, "Hand control back to $name", tint = Color.White) }
                }
            }
            // The picture, full width under the title (aspect-fit); a dark placeholder until there is one.
            val ratio = size?.let { it.width / it.height.coerceAtLeast(1f) } ?: (1364f / 1024f)
            Box(Modifier.fillMaxWidth().aspectRatio(ratio).background(Color.White.copy(alpha = 0.08f))) {
                if (shot != null) PictureImage(shot, Modifier.fillMaxSize().alpha(if (!connected) 0.55f else 1f), ContentScale.Fit)
                val url = liveUrl
                if (url != null) {
                    if (!connected) CircularProgressIndicator(Modifier.align(Alignment.Center).size(24.dp), color = Color.White, strokeWidth = 2.dp)
                    LiveScreenView(
                        url, viewOnly = false, control = control, modifier = Modifier.fillMaxSize().alpha(if (connected) 1f else 0f),
                        onState = { s -> if (s == "connected") connected = true else { connected = false; if (dials < 3) dials++ } },  // a ticket that keeps failing stops after 3 re-dials
                        onClipboard = { text -> remoteCutText = text },
                    )
                    if (connected) {
                        val found = elements
                        val rects = if (directTouch) found?.elements.orEmpty().mapNotNull { e ->
                            val r = e.rect ?: return@mapNotNull null
                            val w = r.width ?: return@mapNotNull null; val h = r.height ?: return@mapNotNull null
                            Rc((r.x ?: 0L).toFloat(), (r.y ?: 0L).toFloat(), w.toFloat(), h.toFloat())
                        } else emptyList()
                        PointerSurface(
                            control, directTouch, Modifier.fillMaxSize(), focusRect, rects,
                            Sz((found?.width ?: 0L).toFloat(), (found?.height ?: 0L).toFloat()),
                        ) { if (directTouch) scheduleElements() }
                    }
                } else CircularProgressIndicator(Modifier.align(Alignment.Center).size(24.dp), color = Color.White, strokeWidth = 2.dp)
            }
            Spacer(Modifier.weight(1f))
            if (keyboardOn && live) KeyAccessoryRow({ control.key(it) }, { pasteFromDevice() }, { keyboardOn = false })
            ControlBar(
                canStop = activeRun != null, onStop = { activeRun?.let { world.stopRun(it.id) } },
                keyboardOn = keyboardOn, onKeyboard = { keyboardOn = !keyboardOn },
                directTouch = directTouch, live = live,
                onMode = {
                    directTouch = !directTouch
                    runCatching { prefs.edit().putBoolean("directTouch", directTouch).apply() }
                    flash(if (directTouch) "Touch: tap where you want to click" else "Trackpad: drag to move the cursor, tap to click")
                },
                onCopy = { copyFromComputer() }, onPaste = { pasteFromDevice() }, onHint = { flash(it) },
            )
        }
        KeyCatcher(keyboardOn && live, { control.text(it) }, { control.key(it) }, Modifier.size(1.dp))
        SnackbarHost(snackbar, Modifier.align(Alignment.Center)) { data ->
            Snackbar(data, containerColor = JunoTheme.colors.card, contentColor = JunoTheme.colors.fg)
        }
    }
}

/** Red Stop on the left, a dark capsule with keyboard, trackpad/touch mode, copy and paste next to it. */
@Composable
private fun ControlBar(
    canStop: Boolean, onStop: () -> Unit, keyboardOn: Boolean, onKeyboard: () -> Unit,
    directTouch: Boolean, live: Boolean, onMode: () -> Unit, onCopy: () -> Unit, onPaste: () -> Unit, onHint: (String) -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(
            Modifier.size(44.dp).clip(CircleShape).background(barFill).alpha(if (canStop) 1f else 0.4f).clickable(enabled = canStop, onClickLabel = "Stop") { onStop() },
            contentAlignment = Alignment.Center,
        ) { Box(Modifier.size(18.dp).clip(CircleShape).background(JunoStatus.danger)) }
        Row(Modifier.clip(RoundedCornerShape(percent = 50)).background(barFill).padding(5.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            BarButton(if (keyboardOn) "Hide keyboard" else "Keyboard", JunoIcons.Keyboard, keyboardOn, true, onKeyboard)
            BarButton(if (directTouch) "Touch mode, switch to trackpad" else "Trackpad mode, switch to touch", if (directTouch) JunoIcons.Pointer else JunoIcons.Mouse, directTouch, live, onMode)
            TransferButton("Copy from computer", JunoIcons.Copy, live, onCopy) { onHint("Copy from computer") }
            TransferButton("Paste to computer", JunoIcons.Paste, live, onPaste) { onHint("Paste to computer") }
        }
    }
}

/** Copy and paste to and from the computer: a tap runs it; a long press names it (the bar has no room for words). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TransferButton(label: String, icon: ImageVector, enabled: Boolean, onClick: () -> Unit, onHint: () -> Unit) {
    Box(
        Modifier.size(width = 44.dp, height = 36.dp).clip(RoundedCornerShape(percent = 50))
            .combinedClickable(enabled = enabled, onClickLabel = label, onLongClickLabel = label, onLongClick = onHint) { onClick() },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = Color.White.copy(alpha = if (enabled) 1f else 0.4f), modifier = Modifier.size(20.dp)) }
}

@Composable
private fun BarButton(label: String, icon: ImageVector, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(width = 44.dp, height = 36.dp).clip(RoundedCornerShape(percent = 50)).background(if (on) Color.White.copy(alpha = 0.2f) else Color.Transparent)
            .clickable(enabled = enabled, onClickLabel = label) { onClick() },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = Color.White.copy(alpha = if (enabled) 1f else 0.4f), modifier = Modifier.size(20.dp)) }
}

/** The keys a phone keyboard lacks (Esc, Tab, arrows), Paste and Hide: Android has no input accessory view, so this row sits above the control bar. */
@Composable
private fun KeyAccessoryRow(onKey: (Int) -> Unit, onPaste: () -> Unit, onHide: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        AccessoryKey("Esc") { onKey(Keysym.ESCAPE) }
        AccessoryKey("Tab") { onKey(Keysym.TAB) }
        BarButton("Left", JunoIcons.ChevronLeft, false, true) { onKey(Keysym.LEFT) }
        BarButton("Right", JunoIcons.ArrowRight, false, true) { onKey(Keysym.RIGHT) }
        Spacer(Modifier.weight(1f))
        BarButton("Paste", JunoIcons.Paste, false, true, onPaste)
        BarButton("Hide keyboard", JunoIcons.ChevronDown, false, true, onHide)
    }
}

@Composable
private fun AccessoryKey(label: String, onClick: () -> Unit) {
    Box(Modifier.height(36.dp).clip(RoundedCornerShape(percent = 50)).background(barFill).clickable { onClick() }.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
        Text(label, style = junoText(TextSize.Sm, FontWeight.Medium), color = Color.White)
    }
}
