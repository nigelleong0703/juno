package io.github.nigelleong0703.juno.debug

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.FrameMetrics
import android.view.Window

/**
 * Debug builds only (this source set is not in release). Logs frame timing from the platform FrameMetrics API, which is
 * available from API 24 and needs no dependency. Every [WINDOW_MS] it prints one summary line under tag `JunoJank`:
 *
 *     frames=312 janky=9 (2.9%) worst=48.1ms over33=2 over700=0
 *
 * A frame is janky when its total duration (input to GPU done) passes the 16.7 ms budget of a 60 Hz display. On 90/120 Hz
 * panels the budget is shorter, so read janky as a relative measure there. Read them with
 * `adb logcat -s JunoJank`, while scrolling the chat list or a conversation on a real device.
 *
 * Installed from MainActivity through reflection, so release builds reference nothing here.
 */
object JankLogger {
    private const val TAG = "JunoJank"
    private const val WINDOW_MS = 5_000L
    private const val BUDGET_NS = 16_666_666L
    private const val NS_PER_MS = 1_000_000.0

    private var windowStart = 0L
    private var frames = 0
    private var janky = 0
    private var over33 = 0
    private var over700 = 0
    private var worst = 0L

    fun install(activity: Activity) {
        val handler = Handler(Looper.getMainLooper())
        activity.window.addOnFrameMetricsAvailableListener(
            Window.OnFrameMetricsAvailableListener { _, metrics, _ -> record(metrics) },
            handler,
        )
        Log.i(TAG, "frame logging on for ${activity.javaClass.simpleName}")
    }

    private fun record(metrics: FrameMetrics) {
        val total = metrics.getMetric(FrameMetrics.TOTAL_DURATION)
        val now = SystemClock.uptimeMillis()
        if (windowStart == 0L) windowStart = now
        frames++
        if (total > BUDGET_NS) janky++
        if (total > 2 * BUDGET_NS) over33++
        if (total > 42 * BUDGET_NS) over700++
        if (total > worst) worst = total
        if (now - windowStart >= WINDOW_MS) {
            Log.i(
                TAG,
                "frames=$frames janky=$janky (${"%.1f".format(100.0 * janky / frames)}%) worst=${"%.1f".format(worst / NS_PER_MS)}ms " +
                    "over33=$over33 over700=$over700",
            )
            windowStart = now
            frames = 0; janky = 0; over33 = 0; over700 = 0; worst = 0L
        }
    }
}
