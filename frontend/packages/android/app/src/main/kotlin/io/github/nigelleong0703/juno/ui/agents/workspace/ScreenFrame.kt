package io.github.nigelleong0703.juno.ui.agents.workspace

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.ui.components.agentTint
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.input.pointer.pointerInput
import io.github.nigelleong0703.juno.state.streamUrl
import io.github.nigelleong0703.juno.ui.agents.takeover.LiveScreenView
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadComputers
import io.github.nigelleong0703.juno.state.refreshScreen
import io.github.nigelleong0703.juno.state.startComputer
import io.github.nigelleong0703.juno.ui.agents.PictureImage
import io.github.nigelleong0703.juno.ui.agents.rememberPictureSize
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The agent's screen (spec 2.8): a still refreshed every 3 s until the live stream (noVNC) connects over it. Precedence: screenshot, no computer, asleep, active run's last step, no screen.
 */
@Composable
fun ScreenFrame(agentId: String, modifier: Modifier = Modifier, fixedAspect: Float? = null) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    var starting by remember { mutableStateOf(false) }
    var startError by remember { mutableStateOf<String?>(null) }
    val agent = state.agent(agentId)
    val shot = data.screenshots[agentId]
    val size = rememberPictureSize(shot)
    val userControl = data.computer?.controller == "user"
    val step = state.activeRunsOf(agentId).firstOrNull()?.steps?.lastOrNull()

    // The live stream (view-only unless the user has control) over the still. The still is polled every 3 s while
    // the stream is not connected (spec 2.8); a ticket is asked for until there is one, and a dropped stream re-dials.
    var liveUrl by remember { mutableStateOf<String?>(null) }
    var connected by remember { mutableStateOf(false) }
    var dials by remember { mutableIntStateOf(0) }
    LaunchedEffect(agentId) { world.loadComputers() }
    LaunchedEffect(agentId, userControl, dials) {
        liveUrl = null; connected = false
        while (!connected) {
            world.refreshScreen(agentId)
            if (liveUrl == null) liveUrl = world.streamUrl(agentId, control = userControl)
            delay(3000)
        }
        world.refreshScreen(agentId)
    }

    fun start() = scope.launch { starting = true; startError = world.startComputer(agentId); starting = false }
    @Composable fun startButton(title: String, pending: String) = Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        JunoButton(if (starting) pending else title, { start() }, enabled = !starting, size = ButtonSize.Large)
        startError?.let { Text(it, style = junoText(TextSize.Xs), color = JunoStatus.danger, textAlign = TextAlign.Center) }
    }

    val ring = if (userControl) BorderRing(5.dp, agentTint(agent)) else BorderRing(1.dp, c.border)
    val shape = RoundedCornerShape(Radius.screen)
    // The real aspect once a still arrived; the web fallback 1364:1024 before (spec 2.8).
    val aspect = fixedAspect ?: size?.let { it.width / it.height.coerceAtLeast(1f) } ?: (1364f / 1024f)
    Box(modifier.fillMaxWidth().aspectRatio(aspect).clip(shape).background(Color.Black.copy(alpha = 0.88f)).border(ring.width, ring.color, shape), contentAlignment = Alignment.Center) {
        when {
            shot != null -> {
                PictureImage(shot, Modifier.fillMaxSize(), ContentScale.Fit)
                liveUrl?.let { url ->
                    LiveScreenView(url, viewOnly = !userControl, modifier = Modifier.fillMaxSize().alpha(if (connected) 1f else 0f), onState = { s -> if (s == "connected") connected = true else { connected = false; if (dials < 3) dials++ } })
                    // Taps go to the frame's own click (full screen), not the page.
                    Box(Modifier.fillMaxSize().pointerInput(Unit) {})
                }
            }
            data.computersLoaded && data.computers.isEmpty() -> ScreenMessage(JunoIcons.Computer, "No computer yet", "Set up a computer for this workspace to let ${agent?.name ?: "this agent"} use it.") { startButton("Set up computer", "Setting up the computer…") }
            data.computer?.state == "asleep" -> ScreenMessage(JunoIcons.Moon, "The computer is asleep", "It wakes when it's needed.")
            step != null -> ScreenMessage(if (step.kind == "shell") JunoIcons.Terminal else JunoIcons.Globe, step.verb.orEmpty(), step.target.orEmpty())
            !data.computersLoaded -> CircularProgressIndicator(Modifier.size(24.dp), color = Color.White, strokeWidth = 2.dp)
            else -> ScreenMessage(JunoIcons.Computer, "No screen yet", "${agent?.name ?: "This agent"} opens one the first time it uses the computer, or you can start it now.") { startButton("Start screen", "Starting screen…") }
        }
    }
}

private class BorderRing(val width: androidx.compose.ui.unit.Dp, val color: Color)

@Composable
private fun ScreenMessage(icon: ImageVector, title: String, description: String, action: (@Composable () -> Unit)? = null) {
    Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, tint = Color.White.copy(alpha = 0.6f), modifier = Modifier.size(32.dp))
        Text(title, style = junoText(TextSize.Md, FontWeight.SemiBold), color = Color.White, textAlign = TextAlign.Center)
        if (description.isNotEmpty()) Text(description, style = junoText(TextSize.Sm), color = Color.White.copy(alpha = 0.7f), textAlign = TextAlign.Center)
        action?.let { Box(Modifier.padding(top = 6.dp)) { it() } }
    }
}
