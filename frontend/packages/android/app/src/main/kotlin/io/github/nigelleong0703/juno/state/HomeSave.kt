package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage

/** How saving a home file ended, as the editor shows it. */
sealed interface HomeSaveResult {
    data object Saved : HomeSaveResult

    /** 409 `HOME_CONFLICT`: the file changed elsewhere. The editor reloads it and asks the user to redo the edit. */
    data object Conflict : HomeSaveResult

    data class Failed(val message: String) : HomeSaveResult
}

object HomeSave {
    const val CONFLICT_MESSAGE = "This changed elsewhere and was reloaded. Review it and make your edit again."

    /**
     * The outcome of a failed save. Null for a cancelled call: that is not a result to show. Only the server's
     * `HOME_CONFLICT` code means "changed elsewhere"; a 409 with any other code is an ordinary failure.
     */
    fun classify(error: Throwable): HomeSaveResult? {
        if (error.isCancellation) return null
        if (error is ApiException.Api && error.status == 409 && error.code == "HOME_CONFLICT") return HomeSaveResult.Conflict
        return HomeSaveResult.Failed(error.userMessage)
    }

    /**
     * A reload (the home revision moved) replaces the editor text only when the user has not typed since the last
     * load; an unsaved edit survives. [loaded] is the text the editor was last loaded or saved with.
     */
    fun textAfterReload(text: String, loaded: String, fresh: String): String = if (text == loaded) fresh else text
}
