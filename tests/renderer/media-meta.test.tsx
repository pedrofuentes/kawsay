// The shared media-type label/icon table (#436) — one source of truth previously
// re-declared, near-identically, in Timeline, Search, ItemView and Collections.
import { describe, expect, it } from 'vitest';
import type { MediaType } from '@shared/kawsay-api';
import { MEDIA_META, MEDIA_TYPE_ORDER } from '@renderer/lib/media-meta';

const ALL_TYPES: MediaType[] = ['photo', 'video', 'audio', 'document', 'message'];

describe('MEDIA_META', () => {
  it('has a label, chipLabel and icon for every MediaType', () => {
    for (const type of ALL_TYPES) {
      expect(MEDIA_META[type].label.length).toBeGreaterThan(0);
      expect(MEDIA_META[type].chipLabel.length).toBeGreaterThan(0);
      expect(MEDIA_META[type].icon.length).toBeGreaterThan(0);
    }
  });

  it('uses the calm, reader-facing labels every view relies on', () => {
    expect(MEDIA_META.photo.label).toBe('Photo');
    expect(MEDIA_META.video.label).toBe('Video');
    expect(MEDIA_META.audio.label).toBe('Voice note');
    expect(MEDIA_META.document.label).toBe('Document');
    expect(MEDIA_META.message.label).toBe('Message');
  });

  it('pluralizes the chip label distinctly from the singular label', () => {
    expect(MEDIA_META.audio.chipLabel).toBe('Voice notes');
    expect(MEDIA_META.audio.chipLabel).not.toBe(MEDIA_META.audio.label);
  });
});

describe('MEDIA_TYPE_ORDER', () => {
  it('lists every MediaType exactly once, in a stable display order', () => {
    expect(MEDIA_TYPE_ORDER).toHaveLength(ALL_TYPES.length);
    expect(new Set(MEDIA_TYPE_ORDER)).toEqual(new Set(ALL_TYPES));
    expect(MEDIA_TYPE_ORDER).toEqual(['photo', 'video', 'audio', 'document', 'message']);
  });
});
