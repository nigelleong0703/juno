// The SSRF-safe GET (private and loopback addresses refused, pinned sockets, manual redirects) for the API's image proxy; the implementation lives in juno-agent.
export { safeFetch, type SafeFetchDeps, type FetchedPage } from 'juno-agent/modules/tools/net/safeFetch';
export { sniffImage, imageSize, type ImageSize } from 'juno-agent/modules/tools/net/imageInfo';

// Feed article image destinations are parsed once for validation and signed media delivery.
export { extractMarkdownImageRefs, rewriteMarkdownImageUrls, type MarkdownImageRef } from 'juno-agent/modules/feed/articleImages';
