// Shared catalog vocabulary (DTOs + literal unions) used on both sides of the
// IPC boundary and by the importer contract. No Node or DOM dependencies.

/** The connector sources Kawsay can import from (ARCHITECTURE §3.1). */
export const SOURCE_TYPES = [
  'folder',
  'whatsapp',
  'google_takeout',
  'messenger',
  'facebook',
  'linkedin',
  'imessage',
  'telegram',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** The kind of memory an item represents. */
export const MEDIA_TYPES = ['photo', 'video', 'audio', 'document', 'message'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/**
 * How an occurrence's original bytes are retained — drives the content-addressed
 * reference count on undo (ARCHITECTURE §4.4):
 *  - `in_place`          folder import: the user's file, never copied
 *  - `content_addressed` archive import: copied once to originals/<hash..>
 *  - `none`              pure message/post (no file-backed original)
 */
export const ORIGINAL_KINDS = ['in_place', 'content_addressed', 'none'] as const;
export type OriginalKind = (typeof ORIGINAL_KINDS)[number];

/** Provenance of an item's canonical capture date. */
export const CAPTURE_DATE_SOURCES = [
  'exif',
  'sidecar',
  'filename',
  'mtime',
  'message',
  'import',
] as const;
export type CaptureDateSource = (typeof CAPTURE_DATE_SOURCES)[number];

/** Generated renditions stored under derived/ (never the original). */
export const ASSET_KINDS = ['thumbnail', 'poster', 'waveform'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
