package io.github.nigelleong0703.juno.ui.character

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import kotlin.math.roundToInt

private const val FRAME_INTERVAL_MS = 1000L / 12L

/**
 * One character in a [size] box. [clip] names the animation (idle, happy, thinking, working, needs_you, sleeping,
 * failed); null shows the static rest pose. Clips play at [CharacterSprite.FPS] and loop.
 *
 * The frame index is derived from the vsync timestamp, so the clip keeps its 12 fps rate on any display refresh rate.
 * Nothing is clipped to the box: the bounce overflows it, as on iOS and watchOS.
 */
@Composable
fun SpriteView(
    character: String,
    clip: String?,
    size: Dp,
    modifier: Modifier = Modifier,
) {
    val sprite = CharacterSprite.of(character)
    val context = LocalContext.current.applicationContext
    val res = if (clip == null) sprite.posterRes else sprite.atlasRes(clip)

    // produceState keeps the previous value until the new atlas decodes, so the result is tagged with its resource name.
    val loaded by produceState<Pair<String, ImageBitmap>?>(initialValue = null, res) {
        value = CharacterAtlasCache.get(context, res)?.let { res to it }
    }
    val atlas = loaded?.takeIf { it.first == res }?.second

    // The frame advances at the clip's own 12 fps, not at vsync: a tick every 83 ms is enough, and it wakes the
    // composition only for the draw. The clock runs only while the activity is resumed, so a backgrounded app idles.
    var frame by remember(character, clip) { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(character, clip, lifecycle) {
        if (clip == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            val start = System.nanoTime()
            while (true) {
                frame = ((System.nanoTime() - start) * CharacterSprite.FPS / 1_000_000_000L % CharacterSprite.FRAME_COUNT).toInt()
                delay(FRAME_INTERVAL_MS)
            }
        }
    }

    Canvas(modifier.size(size)) {
        val image = atlas ?: return@Canvas
        val box = this.size.width
        // Same as the watch's cell(): scale so the rest-pose body fills the box, then centre the body on it.
        val k = box / sprite.bodySize
        val col = frame % CharacterSprite.COLS
        val row = frame / CharacterSprite.COLS
        val cellPx = (CharacterSprite.CELL * k).roundToInt()
        drawImage(
            image = image,
            srcOffset = IntOffset(col * CharacterSprite.CELL, row * CharacterSprite.CELL),
            srcSize = IntSize(CharacterSprite.CELL, CharacterSprite.CELL),
            dstOffset = IntOffset(
                (box / 2 - sprite.bodyCx * k).roundToInt(),
                (box / 2 - sprite.bodyCy * k).roundToInt(),
            ),
            dstSize = IntSize(cellPx, cellPx),
        )
    }
}
