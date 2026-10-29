package io.github.nigelleong0703.juno.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Generates the baseline profile for the release app: cold start, then whatever the first screen offers.
 *
 * Startup, then the first scrollable list (the chat list when signed in, the sign-in carousel when signed out).
 * Opening a conversation is not automated: it needs a signed-in device and a tap target that is not guessed here. Run with `./gradlew :app:generateBaselineProfile` against one connected device.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {

    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(
        packageName = PACKAGE,
        includeInStartupProfile = true,
    ) {
        pressHome()
        startActivityAndWait()
        scrollFirstList()
    }

    /**
     * Flings the first scrollable container (the chat list, or the sign-in carousel) a few times. The node is looked up
     * again before every fling: the list is recomposed as data arrives, which makes a held node stale.
     */
    private fun MacrobenchmarkScope.scrollFirstList() {
        repeat(SCROLLS * 2) { i ->
            val list = device.wait(Until.findObject(By.scrollable(true)), TIMEOUT_MS) ?: return
            list.fling(if (i < SCROLLS) Direction.DOWN else Direction.UP)
            device.waitForIdle()
        }
    }

    private companion object {
        const val PACKAGE = "io.github.nigelleong0703.juno"
        const val TIMEOUT_MS = 5_000L
        const val SCROLLS = 3
    }
}
