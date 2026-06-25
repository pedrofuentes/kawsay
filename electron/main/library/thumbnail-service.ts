// On-demand, id-keyed thumbnail service (U4). The renderer asks `catalog:thumbnail`
// for ONE memory by its opaque catalog id; this service does ALL of the privileged
// work main-side and hands back a self-contained image `data:` URL (or null):
//
//   1. look up the item's media_type by id — non-visual types never touch disk;
//   2. resolve the original through `resolveOriginal`, the AC-14 confinement
//      boundary, which REFUSES anything that would escape the library root (a
//      hostile content-addressing field throws and is never read);
//   3. render a bounded thumbnail via an INJECTED thumbnailer — `nativeImage` for
//      photos, an ffmpeg frame for videos — so this module stays free of Electron
//      and fully unit-testable in the node project;
//   4. cap the bytes, base64 it into a data: URL, and memoise it in a small LRU so
//      a scrolled-back tile never regenerates.
//
// No filesystem path ever crosses back to the renderer, and nothing here opens a
// socket — the whole path is local and egress-free (AC-4).

import { resolveOriginal } from './originals-store';
import type { CatalogDatabase } from '../db/connection';
import type { MediaType } from '@shared/catalog';
import {
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MAX_SIZE,
  THUMBNAIL_MIN_SIZE,
} from '@shared/ipc/schemas';

/** The raster MIME types a thumbnailer may emit (matches the response schema). */
export type ThumbnailMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/** A rendered thumbnail: the encoded bytes plus their raster MIME type. */
export interface ThumbnailImage {
  data: Buffer;
  mimeType: ThumbnailMimeType;
}

/**
 * Render a still from a confined ORIGINAL the service resolved itself — never a
 * renderer-supplied path. `maxDimension` is the longest edge in px. Returns null
 * when the source can't be decoded (one bad file falls back to its type icon).
 */
export type ImageThumbnailer = (
  absPath: string,
  maxDimension: number,
) => Promise<ThumbnailImage | null>;

/** As {@link ImageThumbnailer}, for video originals (one extracted frame). */
export type VideoThumbnailer = (
  absPath: string,
  maxDimension: number,
) => Promise<ThumbnailImage | null>;

export interface ThumbnailServiceOptions {
  db: CatalogDatabase;
  /** Absolute library root — the confinement anchor for original resolution. */
  root: string;
  image: ImageThumbnailer;
  video: VideoThumbnailer;
  /** Hard ceiling on one rendition's bytes (default {@link THUMBNAIL_MAX_BYTES}). */
  maxBytes?: number;
  /** Max distinct (id,size) renditions kept in memory (default 256). */
  cacheLimit?: number;
}

export interface ThumbnailService {
  /** Render (or replay from cache) the thumbnail for one item id, or null. */
  getThumbnail(id: string, size?: number): Promise<string | null>;
}

/** Only photos and videos are visually renderable; everything else gets an icon. */
function thumbnailerFor(
  mediaType: MediaType,
  image: ImageThumbnailer,
  video: VideoThumbnailer,
): ImageThumbnailer | VideoThumbnailer | null {
  if (mediaType === 'photo') return image;
  if (mediaType === 'video') return video;
  return null;
}

/** Clamp a requested edge into the allowed bound; default to the largest size. */
function clampSize(size: number | undefined): number {
  if (size === undefined) return THUMBNAIL_MAX_SIZE;
  if (size < THUMBNAIL_MIN_SIZE) return THUMBNAIL_MIN_SIZE;
  if (size > THUMBNAIL_MAX_SIZE) return THUMBNAIL_MAX_SIZE;
  return Math.floor(size);
}

/** A tiny insertion-ordered LRU so a scrolled-back tile replays instantly. */
class LruCache {
  private readonly map = new Map<string, string>();

  constructor(private readonly limit: number) {}

  get(key: string): string | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: re-insert so it becomes the most-recently-used entry.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/**
 * Build a thumbnail service bound to one open catalog + library root. Pure Node
 * (the heavy decoders are injected), so the whole resolve→confine→render→cache
 * path runs under Vitest exactly as in production.
 */
export function createThumbnailService(options: ThumbnailServiceOptions): ThumbnailService {
  const { db, root, image, video } = options;
  const maxBytes = options.maxBytes ?? THUMBNAIL_MAX_BYTES;
  const cache = new LruCache(options.cacheLimit ?? 256);

  const mediaTypeStmt = db.prepare('SELECT media_type AS mediaType FROM items WHERE id = @id');

  return {
    async getThumbnail(id, size) {
      const dimension = clampSize(size);
      const cacheKey = `${id}:${String(dimension)}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;

      const row = mediaTypeStmt.get<{ mediaType: MediaType }>({ id });
      if (row === undefined) return null;

      // Non-visual media is decided from the catalog alone — no original is ever
      // resolved or read (and an icon is shown in the UI).
      const render = thumbnailerFor(row.mediaType, image, video);
      if (render === null) return null;

      // resolveOriginal is the confinement boundary: it THROWS on a hostile
      // content-addressing field rather than reading outside the store, and that
      // throw deliberately propagates (no path is built, no thumbnailer runs).
      const absPath = resolveOriginal(db, root, id);
      if (absPath === null) return null;

      const rendered = await render(absPath, dimension);
      if (rendered === null || rendered.data.length === 0) return null;
      if (rendered.data.length > maxBytes) return null;

      const dataUrl = `data:${rendered.mimeType};base64,${rendered.data.toString('base64')}`;
      cache.set(cacheKey, dataUrl);
      return dataUrl;
    },
  };
}
