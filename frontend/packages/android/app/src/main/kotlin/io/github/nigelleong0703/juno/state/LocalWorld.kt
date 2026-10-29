package io.github.nigelleong0703.juno.state

import androidx.compose.runtime.staticCompositionLocalOf

/** The process-wide [World], provided once in `JunoApp`. Screens: `val world = LocalWorld.current`. */
val LocalWorld = staticCompositionLocalOf<World> { error("No World provided: wrap the UI in JunoApp") }
