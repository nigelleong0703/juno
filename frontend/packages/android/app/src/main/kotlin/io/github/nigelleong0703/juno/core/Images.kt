package io.github.nigelleong0703.juno.core

import android.content.Context
import coil3.ImageLoader
import coil3.decode.DataSource
import coil3.decode.ImageSource
import coil3.fetch.Fetcher
import coil3.fetch.FetchResult
import coil3.fetch.SourceFetchResult
import coil3.key.Keyer
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.Options
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import okio.Buffer

/** True when [url] is on the signed-in server's origin (scheme, host and port): the only place the session token may go. */
internal fun isServerOrigin(url: HttpUrl, server: String?): Boolean {
    val origin = server?.toHttpUrlOrNull() ?: return false
    return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
}

/**
 * Adds `Authorization: Bearer` to picture requests on the signed-in server's origin, and to nothing else: signed URLs,
 * third-party favicons and feed pictures go without it. Reads the session per request, so a sign-out stops sending it.
 */
internal class SessionAuthInterceptor(private val session: () -> Session?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val current = session()
        if (current == null || request.header("Authorization") != null || !isServerOrigin(request.url, current.server)) {
            return chain.proceed(request)
        }
        return chain.proceed(request.newBuilder().header("Authorization", "Bearer ${current.token}").build())
    }
}

/** A library file, drawn by Coil under its id; the bytes come from the signed-in download (see [libraryImageLoader]). */
data class LibraryPicture(val id: String)

private class LibraryFetcher(
    private val picture: LibraryPicture,
    private val options: Options,
    private val load: suspend (String) -> ByteArray?,
) : Fetcher {
    override suspend fun fetch(): FetchResult? {
        val bytes = load(picture.id) ?: return null
        return SourceFetchResult(
            source = ImageSource(source = Buffer().write(bytes), fileSystem = options.fileSystem),
            mimeType = null,
            dataSource = DataSource.NETWORK,
        )
    }

    class Factory(private val load: suspend (String) -> ByteArray?) : Fetcher.Factory<LibraryPicture> {
        override fun create(data: LibraryPicture, options: Options, imageLoader: ImageLoader): Fetcher =
            LibraryFetcher(data, options, load)
    }
}

/**
 * The app's one image loader: the shared [Http] client with the session header (see [SessionAuthInterceptor]), and
 * library files through [loadLibraryFile]. Coil's memory and disk caches keep their defaults; pictures are decoded at
 * the size they are drawn.
 */
fun libraryImageLoader(
    context: Context,
    session: () -> Session?,
    loadLibraryFile: suspend (String) -> ByteArray?,
): ImageLoader {
    val client = Http.client.newBuilder().addInterceptor(SessionAuthInterceptor(session)).build()
    return ImageLoader.Builder(context)
        .components {
            add(OkHttpNetworkFetcherFactory(callFactory = client))
            add(LibraryFetcher.Factory(loadLibraryFile))
            add(Keyer<LibraryPicture> { data, _ -> "library:${data.id}" })
        }
        .build()
}
