package io.github.nigelleong0703.juno.ui.chat

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream

/** An upload-ready file: the bytes, their type and a small preview. */
class Prepared(val bytes: ByteArray, val mimeType: String, val thumbnail: Bitmap?)

/**
 * Images are shrunk before upload (spec 3): long side at most 1600 px, JPEG quality 80, PNG only when it has transparency,
 * GIF untouched. Anything else goes up as it is. The server accepts 10 MB at most.
 */
object ImageCompressor {
    private const val MAX_SIDE = 1600
    private const val THUMB_SIDE = 192

    fun prepare(bytes: ByteArray, mimeType: String): Prepared {
        if (!mimeType.startsWith("image/")) return Prepared(bytes, mimeType, null)
        if (mimeType == "image/gif") return Prepared(bytes, mimeType, decode(bytes, THUMB_SIDE))
        val full = decode(bytes, MAX_SIDE) ?: return Prepared(bytes, mimeType, null)
        val scaled = scaleDown(full, MAX_SIDE)
        val png = mimeType == "image/png" && scaled.hasAlpha()
        val out = ByteArrayOutputStream()
        scaled.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 80, out)
        val thumb = scaleDown(scaled, THUMB_SIDE)
        return Prepared(out.toByteArray(), if (png) "image/png" else "image/jpeg", thumb)
    }

    /** Decodes with a power-of-two sample so a 48 MP photo never loads at full size. */
    private fun decode(bytes: ByteArray, maxSide: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun scaleDown(bitmap: Bitmap, maxSide: Int): Bitmap {
        val long = maxOf(bitmap.width, bitmap.height)
        if (long <= maxSide) return bitmap
        val k = maxSide.toFloat() / long
        return Bitmap.createScaledBitmap(bitmap, (bitmap.width * k).toInt().coerceAtLeast(1), (bitmap.height * k).toInt().coerceAtLeast(1), true)
    }
}
