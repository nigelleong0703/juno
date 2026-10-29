package io.github.nigelleong0703.juno.ui.agents

import io.github.nigelleong0703.juno.ui.components.JunoIcons
import android.graphics.BitmapFactory
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.nigelleong0703.juno.state.Picture
import io.github.nigelleong0703.juno.ui.components.BytesImage

/**
 * The pixel size of a server picture, read from its header only. The screens reserve the picture's aspect before Coil
 * has drawn it, so this is the one decode-free path; null when the bytes are not an image.
 */
@Composable
fun rememberPictureSize(picture: Picture?): Size? =
    remember(picture) { picture?.let { pictureSize(it.bytes) } }

private fun pictureSize(bytes: ByteArray): Size? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    return if (bounds.outWidth > 0 && bounds.outHeight > 0) Size(bounds.outWidth.toFloat(), bounds.outHeight.toFloat()) else null
}

@Composable
fun PictureImage(picture: Picture, modifier: Modifier = Modifier, scale: ContentScale = ContentScale.FillWidth) {
    BytesImage(picture.bytes, cacheKey = null, modifier = modifier, contentScale = scale)
}

/** Full-screen viewer for a task card screenshot (iOS `ImageViewer`). */
@Composable
fun ImageViewer(picture: Picture, onClose: () -> Unit) {
    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).clickable(onClick = onClose)) {
            PictureImage(picture, Modifier.fillMaxWidth().align(Alignment.Center), ContentScale.FillWidth)
            IconButton(onClose, Modifier.align(Alignment.TopEnd).padding(8.dp)) { Icon(JunoIcons.Close, "Close", tint = Color.White) }
        }
    }
}
