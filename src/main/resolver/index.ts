export { HttpStreamResolver, createStreamResolver, type ResolverOptions } from './streamResolver';
export { parsePls, parseM3u, parsePlaylist, type PlaylistEntry } from './playlist';
export {
  classifyContentType,
  classifyUrlExtension,
  decideBodyKind,
  isHlsManifest,
  looksLikeAudio,
  normaliseContentType,
  sniffBody,
  type BodyKind,
  type ContentClass,
} from './sniff';
export { rawRequest, parseResponseHead, RawHttpError, DEFAULT_USER_AGENT } from './rawHttp';
export type { RawResponse, RawRequestOptions } from './rawHttp';
