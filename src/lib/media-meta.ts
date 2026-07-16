// The one place a media type's calm label(s) and icon are defined. Previously
// re-declared as near-identical `Record<MediaType, ...>` tables in Timeline,
// Search, ItemView and Collections — a plain rename here now reaches every view
// (#436). `chipLabel` (the plural form shown on a filter chip, e.g. "Voice
// notes") is only read by Search's type filter; every other view uses `label`.
import type { MediaType } from '@shared/kawsay-api';
import type { IconName } from '@renderer/components/Icon';

export interface MediaMeta {
  /** Singular label shown on a card/result ("Voice note"). */
  readonly label: string;
  /** Plural label shown on a filter chip ("Voice notes"). */
  readonly chipLabel: string;
  readonly icon: IconName;
}

export const MEDIA_META: Record<MediaType, MediaMeta> = {
  photo: { label: 'Photo', chipLabel: 'Photos', icon: 'photos' },
  video: { label: 'Video', chipLabel: 'Videos', icon: 'video' },
  audio: { label: 'Voice note', chipLabel: 'Voice notes', icon: 'audio' },
  document: { label: 'Document', chipLabel: 'Documents', icon: 'document' },
  message: { label: 'Message', chipLabel: 'Messages', icon: 'messages' },
};

/** A stable display order for media-type filters/chips. */
export const MEDIA_TYPE_ORDER: readonly MediaType[] = [
  'photo',
  'video',
  'audio',
  'document',
  'message',
];
