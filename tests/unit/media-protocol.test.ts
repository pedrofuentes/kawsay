// Unit tests for the hardened `kawsay-media:` protocol (#428). The protocol is the
// ONLY way media bytes reach the renderer, and it is deny-by-default:
//   • the URL must carry a single opaque catalog id (`z.uuid()`) — a path,
//     traversal string, or extra segment never validates (id-only, never a
//     renderer-supplied filesystem path);
//   • an id that resolves to nothing, or whose confinement check throws, yields a
//     4xx and streams NOT ONE byte;
//   • a resolvable memory streams its confined local file with the correct
//     content-type, `Accept-Ranges`, and HTTP range support for video seeking;
//   • the whole path reads a LOCAL file only — it opens no socket (AC-4).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMediaProtocolHandler,
  parseMediaId,
  parseRangeHeader,
  type ResolvedMedia,
} from '../../electron/main/security/media-protocol';
import { mediaUrl } from '@shared/media';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { installEgressSpies } from '../ac4/egress-spies';

const VALID_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function headersOf(init: Record<string, string> = {}): { get(name: string): string | null } {
  const map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

function request(url: string, headers: Record<string, string> = {}) {
  return { url, headers: headersOf(headers) };
}

describe('parseMediaId — the URL carries exactly one opaque uuid (id-only, no paths)', () => {
  it('extracts the uuid from a well-formed media URL', () => {
    expect(parseMediaId(mediaUrl(VALID_ID))).toBe(VALID_ID);
    expect(parseMediaId(`kawsay-media://item/${VALID_ID}`)).toBe(VALID_ID);
  });

  it('rejects a non-uuid id (a path or traversal string never validates)', () => {
    expect(parseMediaId('kawsay-media://item/not-a-uuid')).toBeNull();
    expect(parseMediaId('kawsay-media://item/..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(parseMediaId('kawsay-media://item/../../etc/passwd')).toBeNull();
    expect(parseMediaId('kawsay-media://item/%2e%2e')).toBeNull();
  });

  it('rejects extra path segments, a wrong host, a query, or the wrong scheme', () => {
    expect(parseMediaId(`kawsay-media://item/${VALID_ID}/extra`)).toBeNull();
    expect(parseMediaId(`kawsay-media://item/${VALID_ID}?x=1`)).toBeNull();
    expect(parseMediaId(`kawsay-media://elsewhere/${VALID_ID}`)).toBeNull();
    expect(parseMediaId(`file:///item/${VALID_ID}`)).toBeNull();
    expect(parseMediaId(`https://item/${VALID_ID}`)).toBeNull();
  });

  it('rejects an unparseable URL (deny-by-default)', () => {
    expect(parseMediaId('not a url')).toBeNull();
    expect(parseMediaId('')).toBeNull();
  });
});

describe('parseRangeHeader — HTTP range math for video seeking', () => {
  it('returns null when there is no range header (a full 200 response)', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
  });

  it('parses a bounded range', () => {
    expect(parseRangeHeader('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
    expect(parseRangeHeader('bytes=500-999', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('treats an open-ended range as running to the last byte', () => {
    expect(parseRangeHeader('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('clamps an end past the file to the last byte', () => {
    expect(parseRangeHeader('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('supports a suffix range (last N bytes)', () => {
    expect(parseRangeHeader('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
  });

  it('returns null for a malformed or unsatisfiable range (fall back to full)', () => {
    expect(parseRangeHeader('rows=0-10', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=abc', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=2000-3000', 1000)).toBeNull();
  });
});

describe('createMediaProtocolHandler — hardened id→bytes serving (#428)', () => {
  let root: string;
  let filePath: string;
  const body = Buffer.from('the sound of a loved one, one thousand and twenty-four bytes'.repeat(20));

  beforeEach(() => {
    root = makeTmpDir('media-proto');
    mkdirSync(join(root, 'originals'), { recursive: true });
    filePath = join(root, 'originals', 'clip.bin');
    writeFileSync(filePath, body);
  });
  afterEach(() => {
    removeTmpDir(root);
  });

  function handlerFor(resolve: (id: string) => ResolvedMedia | null) {
    return createMediaProtocolHandler({ resolve });
  }

  it('rejects a malformed id with 400 and streams no bytes', async () => {
    let called = false;
    const handler = handlerFor(() => {
      called = true;
      return { absPath: filePath, mimeType: 'audio/mpeg' };
    });
    const res = await handler(request('kawsay-media://item/not-a-uuid'));
    expect(res.status).toBe(400);
    expect(called).toBe(false);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('returns 404 for an id that resolves to nothing', async () => {
    const handler = handlerFor(() => null);
    const res = await handler(request(mediaUrl(VALID_ID)));
    expect(res.status).toBe(404);
  });

  it('returns 404 — and reads nothing — when the confinement check throws (escaping id)', async () => {
    const handler = handlerFor(() => {
      throw new Error('ERR_ORIGINAL_PATH_ESCAPE: path escapes library root');
    });
    const res = await handler(request(mediaUrl(VALID_ID)));
    expect(res.status).toBe(404);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('reports a PRIVACY-PRESERVING diagnostic (name/code only, never a path) when a serve is rejected', async () => {
    const events: Array<{ name: string; code?: string }> = [];
    const handler = createMediaProtocolHandler({
      resolve: () => {
        const error = new Error('ERR_ORIGINAL_PATH_ESCAPE: /Users/someone/secret escapes root');
        (error as { code?: string }).code = 'ERR_ORIGINAL_PATH_ESCAPE';
        throw error;
      },
      onRejected: (info) => events.push(info),
    });

    const res = await handler(request(mediaUrl(VALID_ID)));
    expect(res.status).toBe(404);
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('Error');
    expect(events[0]?.code).toBe('ERR_ORIGINAL_PATH_ESCAPE');
    // The diagnostic carries ONLY {name,code} — no filesystem path leaks into it.
    expect(JSON.stringify(events[0])).not.toContain('secret');
  });

  it('returns 404 when the resolved file does not exist on disk', async () => {
    const handler = handlerFor(() => ({ absPath: join(root, 'originals', 'missing.bin'), mimeType: 'audio/mpeg' }));
    const res = await handler(request(mediaUrl(VALID_ID)));
    expect(res.status).toBe(404);
  });

  it('streams the whole file with 200, the correct content-type, and Accept-Ranges', async () => {
    const handler = handlerFor(() => ({ absPath: filePath, mimeType: 'video/mp4' }));
    const res = await handler(request(mediaUrl(VALID_ID)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(body.length));
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(body)).toBe(true);
  });

  it('answers a Range request with 206 partial content and the requested slice', async () => {
    const handler = handlerFor(() => ({ absPath: filePath, mimeType: 'video/mp4' }));
    const res = await handler(request(mediaUrl(VALID_ID), { Range: 'bytes=5-14' }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 5-14/${body.length}`);
    expect(res.headers.get('content-length')).toBe('10');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(body.subarray(5, 15))).toBe(true);
  });

  it('opens NO socket while serving a memory — a local file read only (AC-4)', async () => {
    const spies = installEgressSpies();
    try {
      const handler = handlerFor(() => ({ absPath: filePath, mimeType: 'audio/mpeg' }));
      const res = await handler(request(mediaUrl(VALID_ID)));
      await res.arrayBuffer();
      spies.assertNoEgress();
    } finally {
      spies.restore();
    }
  });
});
