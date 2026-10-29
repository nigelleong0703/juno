package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.core.ApiException
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

class HomeSaveTest {
    @Test fun homeConflictCodeOnA409IsAConflict() {
        val conflict = ApiException.Api(409, "HOME_CONFLICT", "changed")
        assertEquals(HomeSaveResult.Conflict, HomeSave.classify(conflict))
    }

    @Test fun anyOtherConflictIsOnlyAFailure() {
        val other = ApiException.Api(409, "SOMETHING_ELSE", "nope")
        assertEquals(HomeSaveResult.Failed("nope"), HomeSave.classify(other))
    }

    @Test fun conflictCodeOnAnotherStatusIsNotAConflict() {
        val wrongStatus = ApiException.Api(500, "HOME_CONFLICT", "server broke")
        assertEquals(HomeSaveResult.Failed("server broke"), HomeSave.classify(wrongStatus))
    }

    @Test fun networkFailureSaysWhatToDo() {
        val result = HomeSave.classify(IOException("offline"))
        assertEquals(HomeSaveResult.Failed("Can't reach the server. Check your connection, or the server address."), result)
    }

    @Test fun cancellationIsNoResult() {
        assertNull(HomeSave.classify(CancellationException("left the screen")))
    }

    @Test fun reloadReplacesTextOnlyWhenTheUserHasNotTyped() {
        // Nothing typed since the last load: the fresh text wins.
        assertEquals("new", HomeSave.textAfterReload(text = "old", loaded = "old", fresh = "new"))
        // The user is mid-edit: their text survives the reload.
        assertEquals("my edit", HomeSave.textAfterReload(text = "my edit", loaded = "old", fresh = "new"))
    }
}
