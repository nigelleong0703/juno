package io.github.nigelleong0703.juno

import android.app.Application
import coil3.SingletonImageLoader
import io.github.nigelleong0703.juno.core.SessionStore
import io.github.nigelleong0703.juno.core.libraryImageLoader
import io.github.nigelleong0703.juno.state.LocalStore
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.downloadLibraryFile
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Owns the process-wide [World]: it outlives activities, so the live stream survives rotation. */
class JunoApplication : Application() {
    lateinit var world: World
        private set

    override fun onCreate() {
        super.onCreate()
        world = World(
            SessionStore(this), CoroutineScope(SupervisorJob() + Dispatchers.Default),
            local = LocalStore(File(filesDir, "juno-store")),
        )
        world.start()
        // Coil's singleton (every AsyncImage): sends the session token to the signed-in server only (core/Images.kt).
        SingletonImageLoader.setSafe { context ->
            libraryImageLoader(
                context,
                session = { world.session.value },
                loadLibraryFile = { id -> runCatching { world.downloadLibraryFile(id).bytes }.getOrNull() },
            )
        }
    }
}
