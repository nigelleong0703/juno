package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import coil3.compose.AsyncImage
import coil3.compose.LocalPlatformContext
import coil3.request.ImageRequest
import io.github.nigelleong0703.juno.core.LibraryPicture
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/** A public https picture (feed post image, link thumbnail). Drawn in the tile colour until it arrives or when it cannot load. */
@Composable
fun RemoteImage(url: String, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop) =
    PictureTile(url, modifier, contentScale)

/** A library file, downloaded with the session and drawn under its id. Same tile rules as [RemoteImage]. */
@Composable
fun LibraryImage(id: String, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop) =
    PictureTile(LibraryPicture(id), modifier, contentScale)

@Composable
private fun PictureTile(model: Any, modifier: Modifier, contentScale: ContentScale) {
    Box(modifier.background(JunoTheme.colors.tile), contentAlignment = Alignment.Center) {
        AsyncImage(model = model, contentDescription = null, contentScale = contentScale, modifier = Modifier.fillMaxSize())
    }
}

/**
 * Picture bytes already in memory (artifact previews, screenshots). [cacheKey] keeps the decoded picture in Coil's memory
 * cache; null leaves it uncached, for frames that change every few seconds.
 */
@Composable
fun BytesImage(bytes: ByteArray, cacheKey: String?, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Fit) {
    val context = LocalPlatformContext.current
    val request = remember(bytes, cacheKey) { ImageRequest.Builder(context).data(bytes).memoryCacheKey(cacheKey).build() }
    AsyncImage(model = request, contentDescription = null, contentScale = contentScale, modifier = modifier)
}
