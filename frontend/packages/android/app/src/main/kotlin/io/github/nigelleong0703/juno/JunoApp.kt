package io.github.nigelleong0703.juno

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.nigelleong0703.juno.nav.MainScaffold
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.markConversationRead
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.ui.onboarding.OnboardingScreen
import io.github.nigelleong0703.juno.ui.onboarding.OnboardingStore
import io.github.nigelleong0703.juno.ui.screens.SignInScreen
import io.github.nigelleong0703.juno.ui.onboarding.ConnectModelGate
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import kotlinx.coroutines.launch

/** The whole UI: theme, the [World] for every screen, and sign-in vs the tab shell (iOS RootView). */
@Composable
fun JunoApp() {
    val world = (LocalContext.current.applicationContext as JunoApplication).world
    CompositionLocalProvider(LocalWorld provides world) {
        JunoTheme {
            ForegroundTracking(world)
            val session by world.session.collectAsState()
            val context = LocalContext.current
            val store = remember { OnboardingStore(context) }
            var seen by remember { mutableStateOf(store.isSeen()) }
            when {
                session != null -> ConnectModelGate { MainScaffold() }
                !seen -> OnboardingScreen { store.markSeen(); seen = true }
                else -> SignInScreen()
            }
        }
    }
}

/** Foreground = an open chat's incoming items are read on arrival; coming back re-reads the agents the stream may have missed. */
@Composable
private fun ForegroundTracking(world: World) {
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> {
                    world.appActive = true
                    world.state.value.currentConversationId?.let { world.markConversationRead(it) }
                    scope.launch { world.refreshAgents() }
                }
                Lifecycle.Event.ON_STOP -> world.appActive = false
                else -> {}
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
}
