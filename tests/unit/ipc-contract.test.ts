import { describe, expect, it } from 'vitest';
import {
  CATALOG_SEARCH,
  CATALOG_THUMBNAIL,
  CATALOG_TIMELINE,
  DIALOG_OPEN_DIRECTORY,
  DIALOG_OPEN_FILE,
  IMPORT_CANCEL,
  IMPORT_START,
  LIBRARY_CREATE,
  LIBRARY_OPEN,
  ipcContract,
} from '@shared/ipc/contract';
import { IMPORT_PROGRESS, ipcEventContract } from '@shared/ipc/events';
import { itemCardSchema } from '@shared/ipc/schemas';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function reqOk(channel: keyof typeof ipcContract, payload: unknown): boolean {
  return ipcContract[channel].request.safeParse(payload).success;
}
function resOk(channel: keyof typeof ipcContract, payload: unknown): boolean {
  return ipcContract[channel].response.safeParse(payload).success;
}

const librarySummary = {
  root: '/Users/mateo/Mum',
  name: 'Mum',
  createdAt: '2026-06-24T00:00:00.000Z',
  schemaVersion: 1,
};

const itemCard = {
  id: UUID,
  mediaType: 'photo',
  mimeType: 'image/jpeg',
  captureDate: '2020-05-01T10:00:00.000Z',
  durationSec: null,
  title: null,
  description: null,
  isFavourite: false,
  width: 480,
  height: 320,
  source: 'whatsapp',
  hasThumbnail: true,
};

describe('ipcContract — library:create', () => {
  it('accepts a path with an optional personName', () => {
    expect(reqOk(LIBRARY_CREATE, { path: '/Users/mateo/Mum', personName: 'Mum' })).toBe(true);
    expect(reqOk(LIBRARY_CREATE, { path: '/Users/mateo/Mum' })).toBe(true);
  });
  it('rejects an empty, oversized, or wrong-typed path', () => {
    expect(reqOk(LIBRARY_CREATE, { path: '' })).toBe(false);
    expect(reqOk(LIBRARY_CREATE, { path: 'x'.repeat(4097) })).toBe(false);
    expect(reqOk(LIBRARY_CREATE, { path: 123 })).toBe(false);
    expect(reqOk(LIBRARY_CREATE, {})).toBe(false);
  });
  it('rejects an oversized personName and unknown keys (strict)', () => {
    expect(reqOk(LIBRARY_CREATE, { path: '/x', personName: 'n'.repeat(201) })).toBe(false);
    expect(reqOk(LIBRARY_CREATE, { path: '/x', rogue: true })).toBe(false);
  });
  it('validates the LibrarySummary response and rejects a malformed one', () => {
    expect(resOk(LIBRARY_CREATE, librarySummary)).toBe(true);
    expect(resOk(LIBRARY_CREATE, { ...librarySummary, schemaVersion: -1 })).toBe(false);
    expect(resOk(LIBRARY_CREATE, { ...librarySummary, name: '' })).toBe(false);
    // The internal catalog filesystem path must never leak to the renderer.
    expect(resOk(LIBRARY_CREATE, { ...librarySummary, catalogPath: '/x/catalog.sqlite3' })).toBe(false);
  });
});

describe('ipcContract — library:open', () => {
  it('accepts a path and rejects an empty one or extra keys', () => {
    expect(reqOk(LIBRARY_OPEN, { path: '/Users/mateo/Mum' })).toBe(true);
    expect(reqOk(LIBRARY_OPEN, { path: '' })).toBe(false);
    expect(reqOk(LIBRARY_OPEN, { path: '/x', personName: 'Mum' })).toBe(false);
  });
});

describe('ipcContract — catalog:timeline', () => {
  it('accepts a bounded limit with an optional opaque cursor', () => {
    expect(reqOk(CATALOG_TIMELINE, { limit: 50 })).toBe(true);
    expect(reqOk(CATALOG_TIMELINE, { limit: 50, cursor: 'opaque' })).toBe(true);
  });
  it('rejects an out-of-range / non-integer limit and an oversized cursor', () => {
    expect(reqOk(CATALOG_TIMELINE, { limit: 0 })).toBe(false);
    expect(reqOk(CATALOG_TIMELINE, { limit: 201 })).toBe(false);
    expect(reqOk(CATALOG_TIMELINE, { limit: 1.5 })).toBe(false);
    expect(reqOk(CATALOG_TIMELINE, { limit: 50, cursor: 'c'.repeat(4097) })).toBe(false);
    expect(reqOk(CATALOG_TIMELINE, { limit: 50, rogue: 1 })).toBe(false);
  });
  it('validates a TimelinePage response (items + nullable cursor)', () => {
    expect(resOk(CATALOG_TIMELINE, { items: [itemCard], nextCursor: 'next' })).toBe(true);
    expect(resOk(CATALOG_TIMELINE, { items: [], nextCursor: null })).toBe(true);
    expect(resOk(CATALOG_TIMELINE, { items: [{ ...itemCard, mediaType: 'hologram' }], nextCursor: null })).toBe(false);
  });
});

describe('ipcContract — catalog:search', () => {
  it('accepts a query and fills limit/offset defaults', () => {
    const parsed = ipcContract[CATALOG_SEARCH].request.parse({ query: 'beach' });
    expect(parsed).toEqual({ query: 'beach', limit: 50, offset: 0 });
  });
  it('rejects an oversized query, bad limit, or negative offset', () => {
    expect(reqOk(CATALOG_SEARCH, { query: 'q'.repeat(513) })).toBe(false);
    expect(reqOk(CATALOG_SEARCH, { query: 'q', limit: 0 })).toBe(false);
    expect(reqOk(CATALOG_SEARCH, { query: 'q', offset: -1 })).toBe(false);
  });
  it('accepts an optional source filter (a known connector) and rejects an unknown one', () => {
    expect(reqOk(CATALOG_SEARCH, { query: 'beach', source: 'whatsapp' })).toBe(true);
    expect(reqOk(CATALOG_SEARCH, { query: 'beach', source: 'folder' })).toBe(true);
    // Omitting the filter stays valid — the source filter is backward-compatible.
    expect(reqOk(CATALOG_SEARCH, { query: 'beach' })).toBe(true);
    // An unknown connector (or wrong type) is rejected by the enum.
    expect(reqOk(CATALOG_SEARCH, { query: 'beach', source: 'myspace' })).toBe(false);
    expect(reqOk(CATALOG_SEARCH, { query: 'beach', source: 123 })).toBe(false);
  });
  it('validates a SearchResult response', () => {
    expect(resOk(CATALOG_SEARCH, { items: [itemCard], total: 1 })).toBe(true);
    expect(resOk(CATALOG_SEARCH, { items: [], total: -1 })).toBe(false);
  });
});

describe('itemCardSchema — the renderer-safe tile carries its source (AC-7)', () => {
  const base = {
    id: UUID,
    mediaType: 'photo',
    mimeType: 'image/jpeg',
    captureDate: '2020-05-01T10:00:00.000Z',
    durationSec: null,
    title: null,
    description: null,
    isFavourite: false,
    width: 480,
    height: 320,
    hasThumbnail: false,
  };

  it('carries a known connector source, allows null, and rejects an unknown one', () => {
    expect(itemCardSchema.safeParse({ ...base, source: 'whatsapp' }).success).toBe(true);
    expect(itemCardSchema.safeParse({ ...base, source: 'google_takeout' }).success).toBe(true);
    // A deduped item with no resolvable occurrence projects a null source.
    expect(itemCardSchema.safeParse({ ...base, source: null }).success).toBe(true);
    expect(itemCardSchema.safeParse({ ...base, source: 'myspace' }).success).toBe(false);
  });

  it('makes the source a required key (no silent omission)', () => {
    expect(itemCardSchema.safeParse(base).success).toBe(false);
  });

  it('requires a boolean hasThumbnail (the renderer-safe thumbnail hint, U4)', () => {
    // It is present and boolean on a well-formed tile…
    expect(itemCardSchema.safeParse({ ...base, source: 'folder' }).success).toBe(true);
    // …required (a tile that omits it is rejected, never silently defaulted)…
    const { hasThumbnail, ...withoutHint } = { ...base, source: 'folder' };
    void hasThumbnail;
    expect(itemCardSchema.safeParse(withoutHint).success).toBe(false);
    // …and strictly a boolean, never a path or other smuggled value.
    expect(itemCardSchema.safeParse({ ...base, source: 'folder', hasThumbnail: 'yes' }).success).toBe(false);
    expect(
      itemCardSchema.safeParse({ ...base, source: 'folder', hasThumbnail: '/var/lib/x.webp' }).success,
    ).toBe(false);
  });
});

describe('ipcContract — catalog:thumbnail (U4: bounded data-URL by opaque id)', () => {
  const dataUrl = `data:image/jpeg;base64,${Buffer.from('a tiny thumbnail').toString('base64')}`;

  it('accepts an opaque uuid id, with an optional bounded size', () => {
    expect(reqOk(CATALOG_THUMBNAIL, { id: UUID })).toBe(true);
    expect(reqOk(CATALOG_THUMBNAIL, { id: UUID, size: 320 })).toBe(true);
    expect(reqOk(CATALOG_THUMBNAIL, { id: UUID, size: 16 })).toBe(true);
  });

  it('rejects a non-uuid id, an out-of-range size, a path, or extra keys (renderer passes ONLY an id)', () => {
    expect(reqOk(CATALOG_THUMBNAIL, { id: 'not-a-uuid' })).toBe(false);
    // Critically: a filesystem path is NOT a valid id — the renderer cannot ask
    // for an arbitrary file, only a catalog id the main process resolves itself.
    expect(reqOk(CATALOG_THUMBNAIL, { id: '/etc/passwd' })).toBe(false);
    expect(reqOk(CATALOG_THUMBNAIL, { id: '../../secret' })).toBe(false);
    expect(reqOk(CATALOG_THUMBNAIL, { id: UUID, size: 0 })).toBe(false);
    expect(reqOk(CATALOG_THUMBNAIL, { id: UUID, size: 321 })).toBe(false);
    expect(reqOk(CATALOG_THUMBNAIL, { id: UUID, size: 1.5 })).toBe(false);
    expect(reqOk(CATALOG_THUMBNAIL, { id: UUID, path: '/etc/passwd' })).toBe(false);
    expect(reqOk(CATALOG_THUMBNAIL, {})).toBe(false);
  });

  it('returns a bounded image data-URL, or null — never a path, remote scheme, or markup', () => {
    expect(resOk(CATALOG_THUMBNAIL, dataUrl)).toBe(true);
    expect(resOk(CATALOG_THUMBNAIL, null)).toBe(true);
    // Only image data URLs ride back — never data:text/html, a remote URL, or a path.
    expect(resOk(CATALOG_THUMBNAIL, 'data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(resOk(CATALOG_THUMBNAIL, 'https://evil.example/x.png')).toBe(false);
    expect(resOk(CATALOG_THUMBNAIL, '/var/lib/kawsay/derived/x.webp')).toBe(false);
    expect(resOk(CATALOG_THUMBNAIL, '')).toBe(false);
    // An unbounded string cannot cross the boundary.
    expect(resOk(CATALOG_THUMBNAIL, `data:image/png;base64,${'A'.repeat(2_000_000)}`)).toBe(false);
  });
});

describe('ipcContract — import:start / import:cancel', () => {
  it('accepts a known sourceType + inputPath and returns a jobId', () => {
    expect(reqOk(IMPORT_START, { sourceType: 'folder', inputPath: '/x' })).toBe(true);
    expect(reqOk(IMPORT_START, { sourceType: 'whatsapp', inputPath: '/x.zip' })).toBe(true);
    expect(resOk(IMPORT_START, { jobId: UUID })).toBe(true);
    expect(resOk(IMPORT_START, { jobId: 'not-a-uuid' })).toBe(false);
  });
  it('rejects an unknown sourceType, empty/oversized inputPath, or extra keys', () => {
    expect(reqOk(IMPORT_START, { sourceType: 'myspace', inputPath: '/x' })).toBe(false);
    expect(reqOk(IMPORT_START, { sourceType: 'folder', inputPath: '' })).toBe(false);
    expect(reqOk(IMPORT_START, { sourceType: 'folder', inputPath: 'x'.repeat(4097) })).toBe(false);
    expect(reqOk(IMPORT_START, { sourceType: 'folder', inputPath: '/x', rogue: 1 })).toBe(false);
  });
  it('cancel requires a uuid jobId and returns a cancelled flag', () => {
    expect(reqOk(IMPORT_CANCEL, { jobId: UUID })).toBe(true);
    expect(reqOk(IMPORT_CANCEL, { jobId: 'nope' })).toBe(false);
    expect(resOk(IMPORT_CANCEL, { cancelled: true })).toBe(true);
    expect(resOk(IMPORT_CANCEL, { cancelled: 'yes' })).toBe(false);
  });
});

describe('ipcContract — dialog:openDirectory / dialog:openFile (W2 native picker)', () => {
  // Both channels share the same renderer-facing option whitelist and the same
  // nullable-path response shape, so the assertions run against each in turn.
  for (const channel of [DIALOG_OPEN_DIRECTORY, DIALOG_OPEN_FILE] as const) {
    describe(channel, () => {
      it('accepts no options, or only a whitelisted title and/or defaultPath', () => {
        expect(reqOk(channel, {})).toBe(true);
        expect(reqOk(channel, { title: 'Choose a folder' })).toBe(true);
        expect(reqOk(channel, { title: 'Choose', defaultPath: '/Users/mateo' })).toBe(true);
        expect(reqOk(channel, { defaultPath: '/Users/mateo' })).toBe(true);
      });

      it('rejects an empty or oversized title or defaultPath', () => {
        expect(reqOk(channel, { title: '' })).toBe(false);
        expect(reqOk(channel, { title: 'x'.repeat(201) })).toBe(false);
        expect(reqOk(channel, { defaultPath: '' })).toBe(false);
        expect(reqOk(channel, { defaultPath: 'x'.repeat(4097) })).toBe(false);
      });

      it('refuses to pass through arbitrary main-side dialog options (strict whitelist)', () => {
        // The renderer must NOT be able to smuggle privileged Electron dialog
        // options across the boundary — `properties`, `filters`, `message`, etc.
        // are rejected outright, not silently stripped.
        expect(reqOk(channel, { properties: ['openFile'] })).toBe(false);
        expect(reqOk(channel, { title: 'ok', message: 'evil' })).toBe(false);
        expect(reqOk(channel, { title: 'ok', filters: [{ name: 'all', extensions: ['*'] }] })).toBe(false);
        expect(reqOk(channel, { rogue: true })).toBe(false);
      });

      it('returns a non-empty absolute path string, or null when the user cancels', () => {
        expect(resOk(channel, '/Users/mateo/Pictures')).toBe(true);
        expect(resOk(channel, null)).toBe(true);
        expect(resOk(channel, '')).toBe(false);
        expect(resOk(channel, 123)).toBe(false);
        // The response is a bare string|null — never an object that could leak more.
        expect(resOk(channel, { path: '/Users/mateo' })).toBe(false);
      });
    });
  }
});

describe('ipcEventContract — import:progress', () => {
  const schema = ipcEventContract[IMPORT_PROGRESS];
  const summary = {
    recordCount: 3,
    itemsTouched: 3,
    occurrencesAdded: 3,
    assetsAdded: 1,
    thumbnailFailures: 0,
    skipped: [{ ref: 'broken.heic', reason: 'unreadable', code: 'E_DECODE' }],
    cancelled: false,
  };

  it('accepts an in-flight progress tick (no summary, no error)', () => {
    expect(
      schema.safeParse({
        jobId: UUID,
        phase: 'emit',
        processed: 2,
        total: 3,
        message: '2 photos found',
        summary: null,
        error: null,
      }).success,
    ).toBe(true);
  });

  it('accepts a terminal done event carrying the summary', () => {
    expect(
      schema.safeParse({
        jobId: UUID,
        phase: 'done',
        processed: 3,
        total: 3,
        message: null,
        summary,
        error: null,
      }).success,
    ).toBe(true);
  });

  it('accepts a terminal error event', () => {
    expect(
      schema.safeParse({
        jobId: UUID,
        phase: 'done',
        processed: 0,
        total: null,
        message: null,
        summary: null,
        error: 'unsupported source',
      }).success,
    ).toBe(true);
  });

  it('rejects a bad phase, negative counts, missing jobId, or unknown keys', () => {
    expect(schema.safeParse({ jobId: UUID, phase: 'teleporting', processed: 1, total: null, message: null, summary: null, error: null }).success).toBe(false);
    expect(schema.safeParse({ jobId: UUID, phase: 'emit', processed: -1, total: null, message: null, summary: null, error: null }).success).toBe(false);
    expect(schema.safeParse({ phase: 'emit', processed: 1, total: null, message: null, summary: null, error: null }).success).toBe(false);
    expect(schema.safeParse({ jobId: 'nope', phase: 'emit', processed: 1, total: null, message: null, summary: null, error: null }).success).toBe(false);
    expect(schema.safeParse({ jobId: UUID, phase: 'emit', processed: 1, total: null, message: null, summary: null, error: null, rogue: true }).success).toBe(false);
  });
});
