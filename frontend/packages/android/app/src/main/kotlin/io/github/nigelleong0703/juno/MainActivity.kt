package io.github.nigelleong0703.juno

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import android.graphics.Color
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.fragment.app.FragmentActivity
import io.github.nigelleong0703.juno.state.connectorReturned
import io.github.nigelleong0703.juno.state.parseConnectorReturn

/** A FragmentActivity because BiometricPrompt (the vault's unlock) needs one. */
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // The status bar is transparent so each screen draws under it; its icons follow the app theme (JunoTheme).
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT))
        if (BuildConfig.DEBUG) installDebugJankLogger()
        setContent { JunoApp() }
        // A recreated activity gets its intent back again; the first delivery already handled it.
        if (savedInstanceState == null) handleConnectorReturn(intent)
    }

    /** singleTask: the browser's `juno://connectors` redirect arrives here while the app is already running. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleConnectorReturn(intent)
    }

    private fun handleConnectorReturn(intent: Intent?) {
        val ret = parseConnectorReturn(intent?.dataString) ?: return
        // Consume the link so a rotation or a later onCreate does not replay it.
        intent?.data = null
        (application as JunoApplication).world.connectorReturned(ret)
    }

    /** Debug builds only: the logger lives in the debug source set, so release never references it (R8 drops this branch). */
    private fun installDebugJankLogger() {
        runCatching {
            Class.forName("io.github.nigelleong0703.juno.debug.JankLogger").getMethod("install", Activity::class.java).invoke(null, this)
        }
    }
}
