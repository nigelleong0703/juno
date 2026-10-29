package io.github.nigelleong0703.juno.ui.character

import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The animated characters, the same art the iPhone and watch apps use (`packages/ios/Juno/Characters`, copied to
 * `res/drawable-nodpi` as `character_<name>_<clip>.webp`; the rest pose is `character_<name>_poster.webp`, except
 * star's, which is `character_star.webp`). One 8-column atlas of 256 px cells per clip, 54 frames at 12 fps.
 *
 * [bodyCx], [bodyCy] and [bodySize] locate the rest-pose body inside a 256 px cell. The cell is scaled so that body
 * fills the box and is centred on it; the bounce overflows the box, so nothing is clipped to it.
 */
class CharacterSprite private constructor(
    val name: String,
    internal val posterRes: String,
    internal val bodyCx: Float,
    internal val bodyCy: Float,
    internal val bodySize: Float,
) {
    internal fun atlasRes(clip: String): String = "character_${name}_$clip"

    companion object {
        const val FRAME_COUNT = 54
        const val FPS = 12L
        internal const val CELL = 256
        internal const val COLS = 8

        val all: Map<String, CharacterSprite> = mapOf(
            "mint" to CharacterSprite("mint", "character_mint_poster", 140f, 133f, 178f),
            "blue" to CharacterSprite("blue", "character_blue_poster", 144f, 138.5f, 186f),
            "purple" to CharacterSprite("purple", "character_purple_poster", 137.5f, 134.5f, 186f),
            "pink" to CharacterSprite("pink", "character_pink_poster", 126.5f, 130f, 192f),
            "star" to CharacterSprite("star", "character_star", 134.5f, 118.5f, 197f),
            "bean" to CharacterSprite("bean", "character_bean_poster", 123.5f, 117f, 208f),
        )

        /** Web lib/avatars.ts CHARACTER_ORDER: the character an agent without a saved choice gets. */
        val order: List<String> = listOf("mint", "blue", "purple", "pink", "star", "bean")

        /** Sprite for [name], falling back to bean like the watch and iPhone do. */
        fun of(name: String): CharacterSprite = all[name] ?: all.getValue("bean")

        /** FNV-1a 32-bit over the UTF-16 code units of [agentId], as web hashString and the other platforms do. */
        fun defaultCharacter(agentId: String): String {
            var hash: UInt = 0x811c9dc5u
            for (unit in agentId) {
                hash = hash xor unit.code.toUInt()
                hash *= 0x01000193u
            }
            return order[(hash % order.size.toUInt()).toInt()]
        }
    }
}

/**
 * Decoded atlases, at most [CHARACTER_ATLAS_CACHE_SIZE] of them (each is about 14 MB as ARGB_8888). Least recently
 * used is evicted first. Decoding happens on [Dispatchers.IO].
 */
internal object CharacterAtlasCache {
    private val mutex = Mutex()
    private val cache = LinkedHashMap<String, ImageBitmap>(4, 0.75f, true)

    suspend fun get(context: Context, res: String): ImageBitmap? {
        mutex.withLock { cache[res]?.let { return it } }
        val decoded = withContext(Dispatchers.IO) { decode(context, res) } ?: return null
        mutex.withLock {
            // Another caller may have decoded the same atlas while we were not holding the lock.
            cache[res]?.let { return it }
            cache[res] = decoded
            while (cache.size > CHARACTER_ATLAS_CACHE_SIZE) cache.remove(cache.keys.first())
        }
        return decoded
    }

    private fun decode(context: Context, res: String): ImageBitmap? {
        val id = context.resources.getIdentifier(res, "drawable", context.packageName)
        if (id == 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = 1
            inScaled = false
        }
        return BitmapFactory.decodeResource(context.resources, id, options)?.asImageBitmap()
    }
}

// Four atlases (about 15 MB each as ARGB_8888) so that rows scrolling back into view do not decode their atlas again.
private const val CHARACTER_ATLAS_CACHE_SIZE = 4
