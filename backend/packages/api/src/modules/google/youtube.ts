/**
 * YouTube on the YouTube Data API v3, in two hosted servers (modules/google-mcp.ts): `youtube` is public (this
 * deployment's YOUTUBE_API_KEY, no sign-in, no personal data: search, charts, video details, music) and
 * `youtube-account` is the owner's own (playlists, likes, subscriptions; `youtube.readonly`). The usage rules for
 * choosing between the tools live in their descriptions, because that is where the model reads them.
 */
import { itemsOf, page, PAGE, str, type HostedTool } from './shared.js';

export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];
const MUSIC_CATEGORY = '10';
const WWW = 'www.youtube.com';
const MUSIC = 'music.youtube.com';

function snippetOf(item: Record<string, unknown>): Record<string, unknown> {
  const snippet = item.snippet;
  return typeof snippet === 'object' && snippet !== null ? (snippet as Record<string, unknown>) : {};
}

/** A video id wherever the resource keeps it (search results, playlist items, videos). */
function videoIdOf(item: Record<string, unknown>): string | undefined {
  const id = item.id;
  if (typeof id === 'string') return id;
  if (typeof id === 'object' && id !== null && typeof Reflect.get(id, 'videoId') === 'string') return Reflect.get(id, 'videoId') as string;
  const resource = snippetOf(item).resourceId;
  return typeof resource === 'object' && resource !== null ? str(Reflect.get(resource, 'videoId')) : undefined;
}

/** A link to a video on the given YouTube host. */
function watchLink(host: string): (item: Record<string, unknown>) => string | undefined {
  return (item) => {
    const id = videoIdOf(item);
    return id === undefined ? undefined : 'https://' + host + '/watch?v=' + id;
  };
}

/** The fields an agent needs from a list response, with links into the app the service opens. */
function listing(body: Record<string, unknown>, link: (item: Record<string, unknown>) => string | undefined, extra?: (item: Record<string, unknown>) => Record<string, unknown>) {
  return {
    items: itemsOf(body).map((item) => {
      const snippet = snippetOf(item);
      return {
        title: snippet.title,
        channel: snippet.videoOwnerChannelTitle ?? snippet.channelTitle,
        publishedAt: snippet.publishedAt,
        url: link(item),
        ...(extra === undefined ? {} : extra(item)),
      };
    }),
    ...(typeof body.nextPageToken === 'string' ? { nextPageToken: body.nextPageToken } : {}),
  };
}

/** The search filters both search tools pass straight through to search.list; each says when to use it. */
const SEARCH_FILTERS = {
  regionCode: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. SG: results viewable in that country. Add it when the user wants what is available where they are.' },
  publishedAfter: { type: 'string', description: 'RFC 3339 time, e.g. 2026-10-11T00:00:00Z: only results published at or after it. For latest / new / this week, set this to the start of the period and use order date.' },
  publishedBefore: { type: 'string', description: 'RFC 3339 time: only results published before it.' },
  videoDuration: { type: 'string', enum: ['any', 'short', 'medium', 'long'], description: 'short is under 4 minutes (use it for Shorts), medium 4 to 20, long over 20 (videos only).' },
  relevanceLanguage: { type: 'string', description: 'ISO 639-1 language code (zh-Hans, zh-Hant for Chinese, en, ...): prefer results relevant to the language the user wants.' },
  eventType: { type: 'string', enum: ['live', 'upcoming', 'completed'], description: 'Live broadcasts: live now, upcoming, or completed. Use live for "live now"; only with type video.' },
  channelId: { type: 'string', description: "Only results from this channel id. With order date it gives a creator's newest videos (find the channel id first with a search of type channel)." },
};

const ORDER = { type: 'string', enum: ['relevance', 'date', 'viewCount', 'rating'], description: 'Sort order (default relevance). Use date for newest; viewCount only for the most viewed of all time.' };
const REGION = { type: 'string', description: "ISO 3166-1 alpha-2 country code, e.g. SG (default US). Use the user's country from what you know about them; ask once if you do not know it, never assume one." };

function searchFilters(args: Record<string, unknown>) {
  return {
    regionCode: str(args.regionCode),
    publishedAfter: str(args.publishedAfter),
    publishedBefore: str(args.publishedBefore),
    videoDuration: str(args.videoDuration),
    relevanceLanguage: str(args.relevanceLanguage),
    eventType: str(args.eventType),
    channelId: str(args.channelId),
  };
}

/** videos.list chart=mostPopular: YouTube's own popular chart, with views so old and new can be told apart. */
async function popularChart(api: Parameters<HostedTool['run']>[0], args: Record<string, unknown>, watch: (item: Record<string, unknown>) => string | undefined, categoryId: string | undefined) {
  const body = await api('/videos', { part: 'snippet,statistics', chart: 'mostPopular', regionCode: str(args.regionCode), videoCategoryId: categoryId, ...page(args) });
  return listing(body, watch, (item) => ({ views: Reflect.get((item.statistics as object | undefined) ?? {}, 'viewCount') }));
}

export const YOUTUBE_PUBLIC_TOOLS: HostedTool[] = (() => {
  const watch = watchLink(WWW);
  const musicWatch = watchLink(MUSIC);
  const searchKind = (item: Record<string, unknown>) => {
    const id = item.id as Record<string, unknown> | undefined;
    if (typeof id?.playlistId === 'string') return { url: 'https://' + WWW + '/playlist?list=' + id.playlistId };
    if (typeof id?.channelId === 'string') return { url: 'https://' + WWW + '/channel/' + id.channelId };
    return {};
  };
  return [
    {
      name: 'search',
      title: 'Search YouTube',
      description: "Search YouTube's catalogue for videos, channels or playlists. Not for what is hot/trending/popular now (use list_popular) and not for general facts or news (use web_search). Results carry no view counts; get_videos adds them when views matter. Check the dates: if results are old for what was asked, say so and retry once with a date filter. Costs 100 quota units: one or two calls per answer, never loop over pages or queries.",
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        type: { type: 'string', enum: ['video', 'channel', 'playlist'], description: 'Kind of result (default video).' },
        order: ORDER,
        ...SEARCH_FILTERS,
        ...PAGE,
      },
      required: ['query'],
      run: async (api, args) => listing(
        await api('/search', { part: 'snippet', q: str(args.query), type: str(args.type) ?? 'video', order: str(args.order), ...searchFilters(args), ...page(args) }),
        watch,
        searchKind,
      ),
    },
    {
      name: 'list_popular',
      title: 'Popular on YouTube',
      description: "YouTube's official most-popular chart for a country, optionally for one video category (10 music, 20 gaming, 25 news); includes views. Use it for anything hot, trending or popular right now, never a search for the word \"trending\". Costs 1 quota unit.",
      properties: {
        regionCode: REGION,
        videoCategoryId: { type: 'string', description: 'Video category id; leave out for all categories.' },
        ...PAGE,
      },
      run: async (api, args) => popularChart(api, args, watch, str(args.videoCategoryId)),
    },
    {
      name: 'get_videos',
      title: 'Video details',
      description: 'Details of videos by id: title, channel, description, duration, views and likes. Use it after search when views matter, since search results have none.',
      properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Video ids.' } },
      required: ['ids'],
      run: async (api, args) => {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string').slice(0, 50) : [];
        return listing(await api('/videos', { part: 'snippet,contentDetails,statistics', id: ids.join(',') }), watch, (item) => ({
          description: String(snippetOf(item).description ?? '').slice(0, 1000),
          duration: Reflect.get((item.contentDetails as object | undefined) ?? {}, 'duration'),
          views: Reflect.get((item.statistics as object | undefined) ?? {}, 'viewCount'),
          likes: Reflect.get((item.statistics as object | undefined) ?? {}, 'likeCount'),
        }));
      },
    },
    {
      name: 'search_music',
      title: 'Search YouTube Music',
      description: 'Search songs and music videos on YouTube Music; results link to music.youtube.com. Not for what is popular now (use list_popular_music). Results carry no view counts. Costs 100 quota units: one or two calls per answer.',
      properties: {
        query: { type: 'string', description: 'Song, artist, album or mood.' },
        order: ORDER,
        ...SEARCH_FILTERS,
        ...PAGE,
      },
      required: ['query'],
      run: async (api, args) => listing(await api('/search', { part: 'snippet', type: 'video', videoCategoryId: MUSIC_CATEGORY, q: str(args.query), order: str(args.order), ...searchFilters(args), ...page(args) }), musicWatch),
    },
    {
      name: 'list_popular_music',
      title: 'Popular music',
      description: "YouTube's official most-popular chart for the Music category, for a country; includes views. Use it for hot or trending music. Costs 1 quota unit.",
      properties: { regionCode: REGION, ...PAGE },
      run: async (api, args) => popularChart(api, args, musicWatch, MUSIC_CATEGORY),
    },
  ];
})();

export const YOUTUBE_ACCOUNT_TOOLS: HostedTool[] = (() => {
  const watch = watchLink(WWW);
  const playlistUrl = (item: Record<string, unknown>) => (typeof item.id === 'string' ? 'https://' + WWW + '/playlist?list=' + item.id : undefined);
  return [
    {
      name: 'list_my_playlists',
      title: 'My playlists',
      description: "List the owner's YouTube playlists (YouTube Music shares them).",
      properties: { ...PAGE },
      run: async (api, args) => listing(await api('/playlists', { part: 'snippet,contentDetails', mine: 'true', ...page(args) }), playlistUrl, (item) => ({
        id: item.id,
        count: Reflect.get((item.contentDetails as object | undefined) ?? {}, 'itemCount'),
      })),
    },
    {
      name: 'list_playlist_items',
      title: 'Playlist contents',
      description: 'List the videos or songs in a playlist (id from list_my_playlists, or from a search in the YouTube connector).',
      properties: { playlistId: { type: 'string', description: 'Playlist id.' }, ...PAGE },
      required: ['playlistId'],
      run: async (api, args) => listing(await api('/playlistItems', { part: 'snippet', playlistId: str(args.playlistId), ...page(args) }), watch),
    },
    {
      name: 'list_liked_videos',
      title: 'My liked videos',
      description: 'List the videos the owner liked, newest first.',
      properties: { ...PAGE },
      run: async (api, args) => listing(await api('/videos', { part: 'snippet', myRating: 'like', ...page(args) }), watch),
    },
    {
      name: 'list_liked_music',
      title: 'My liked music',
      description: 'List the songs and music videos the owner liked, newest first.',
      properties: { ...PAGE },
      // Liked videos of every kind, filtered to the Music category (the liked-songs list of the app has no public API).
      run: async (api, args) => {
        const body = await api('/videos', { part: 'snippet', myRating: 'like', ...page(args) });
        return listing({ ...body, items: itemsOf(body).filter((item) => snippetOf(item).categoryId === MUSIC_CATEGORY) }, watch);
      },
    },
    {
      name: 'list_subscriptions',
      title: 'My subscriptions',
      description: 'List the channels the owner subscribes to.',
      properties: { ...PAGE },
      run: async (api, args) => listing(await api('/subscriptions', { part: 'snippet', mine: 'true', ...page(args) }), (item) => {
        const resource = snippetOf(item).resourceId as Record<string, unknown> | undefined;
        return typeof resource?.channelId === 'string' ? 'https://' + WWW + '/channel/' + resource.channelId : undefined;
      }),
    },
  ];
})();
