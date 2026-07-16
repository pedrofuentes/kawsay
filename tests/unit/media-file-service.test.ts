// Unit tests for the id→PINNED-fd media resolver behind the `kawsay-media:`
// protocol (#428). Mirrors the thumbnail-service posture (U4 / AC-14): the renderer
// names ONLY an opaque catalog id, and the service resolves it server-side to a
// CONFINED original. To close the validate-then-reopen TOCTOU (§2.4), it realpaths
// + containment-checks ONCE, then OPENS the canonical (symlink-free) path to a file
// descriptor and returns the FD — so the exact file validated is the exact file
// streamed. It THROWS on an escaping content-address / in-place symlink swap rather
// than handing out a servable file. No renderer-supplied path is ever accepted, and
// the whole path is egress-free (AC-4).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { openCatalog, type CatalogDatabase } from '../../electron/main/db/connection';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import { constants as fsConstants } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  blobAbsPath,
  ERR_ORIGINAL_PATH_ESCAPE,
  isServablePath,
  MEDIA_OPEN_FLAGS,
  pinRegularFile,
} from '../../electron/main/library/originals-store';
import {
  createMediaFileService,
  type MediaFileDescriptor,
} from '../../electron/main/library/media-file-service';
import { createMediaProtocolHandler } from '../../electron/main/security/media-protocol';
import { mediaUrl } from '@shared/media';
import type { MediaType } from '@shared/catalog';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { installEgressSpies } from '../ac4/egress-spies';

/** Request headers stand-in with no Range (a full serve). */
function noRangeHeaders(): { get(name: string): string | null } {
  return { get: () => null };
}

/** Close a resolved descriptor's pinned fd so a unit test never leaks it. */
function closeDescriptor(descriptor: MediaFileDescriptor | null): void {
  if (descriptor !== null) {
    try {
      closeSync(descriptor.fd);
    } catch {
      /* already closed */
    }
  }
}

/** A canonical 64-hex content hash seeded from a single distinguishing nibble. */
function hash(nibble: string): string {
  return nibble.repeat(64);
}

/** Write a real content-addressed blob on disk (its shard dir + bytes) so the
 *  resolver can open + pin it — content-addressed serving now requires the file. */
function writeBlob(root: string, contentHash: string, ext: string, bytes: Buffer): string {
  const path = blobAbsPath(root, contentHash, ext);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

describe('createMediaFileService (id-keyed, path-confined media resolution — #428 / AC-14)', () => {
  let root: string;
  let db: CatalogDatabase;
  let repo: CatalogRepo;
  let sourceId: string;

  beforeEach(() => {
    root = makeTmpDir('media-svc');
    db = openCatalog(join(root, 'catalog.sqlite3'));
    runMigrations(db);
    repo = createCatalogRepo(db);
    sourceId = repo.registerSource({ sourceKey: 'seed', type: 'folder', label: 'Seed' });
  });
  afterEach(() => {
    db.close();
    removeTmpDir(root);
  });

  /** Seed an item with one occurrence and return its opaque catalog id. */
  function seedItem(
    mediaType: MediaType,
    opts: {
      contentHash?: string | null;
      mimeType?: string | null;
      originalExt?: string | null;
      kind?: 'content_addressed' | 'in_place' | 'none';
      path?: string;
    } = {},
  ): string {
    const id = repo.insertItem({
      mediaType,
      mimeType: opts.mimeType ?? null,
      contentHash: opts.contentHash ?? null,
      originalExt: opts.originalExt ?? '.bin',
    });
    repo.addOccurrence({
      itemId: id,
      sourceId,
      sourceRef: `ref/${id}`,
      originalKind: opts.kind ?? 'none',
      originalPath: opts.path ?? null,
    });
    return id;
  }

  it('resolves an audio memory by id to a PINNED fd on the confined original (never a renderer path)', () => {
    writeBlob(root, hash('a'), '.mp3', Buffer.from('the sound of a voice'));
    const service = createMediaFileService({ db, root });
    const id = seedItem('audio', {
      contentHash: hash('a'),
      mimeType: 'audio/mpeg',
      originalExt: '.mp3',
      kind: 'content_addressed',
    });

    const descriptor = service.resolve(id);
    expect(descriptor).not.toBeNull();
    // A pinned, positive file descriptor on a regular file — NOT a path string.
    expect(typeof descriptor?.fd).toBe('number');
    expect(descriptor?.fd).toBeGreaterThanOrEqual(0);
    expect(descriptor?.size).toBe('the sound of a voice'.length);
    expect(descriptor?.mimeType).toBe('audio/mpeg');
    expect(descriptor?.mediaType).toBe('audio');
    closeDescriptor(descriptor);
  });

  it('resolves a video memory by id', () => {
    writeBlob(root, hash('b'), '.mp4', Buffer.from('home movie'));
    const service = createMediaFileService({ db, root });
    const id = seedItem('video', {
      contentHash: hash('b'),
      mimeType: 'video/mp4',
      originalExt: '.mp4',
      kind: 'content_addressed',
    });
    const descriptor = service.resolve(id);
    expect(descriptor?.mediaType).toBe('video');
    expect(descriptor?.mimeType).toBe('video/mp4');
    closeDescriptor(descriptor);
  });

  it('resolves a photo memory by id (images open full-size through the same protocol)', () => {
    writeBlob(root, hash('c'), '.jpg', Buffer.from('a photo'));
    const service = createMediaFileService({ db, root });
    const id = seedItem('photo', {
      contentHash: hash('c'),
      mimeType: 'image/jpeg',
      originalExt: '.jpg',
      kind: 'content_addressed',
    });
    const descriptor = service.resolve(id);
    expect(descriptor?.mediaType).toBe('photo');
    expect(descriptor?.mimeType).toBe('image/jpeg');
    closeDescriptor(descriptor);
  });

  it('derives a sane content-type from the extension when the catalog stored none', () => {
    writeBlob(root, hash('d'), '.m4a', Buffer.from('x'));
    const service = createMediaFileService({ db, root });
    const id = seedItem('audio', {
      contentHash: hash('d'),
      mimeType: null,
      originalExt: '.m4a',
      kind: 'content_addressed',
    });
    const descriptor = service.resolve(id);
    expect(descriptor?.mimeType).toBe('audio/mp4');
    closeDescriptor(descriptor);
  });

  it('returns null for a content-addressed blob that is not on disk (nothing to serve)', () => {
    const service = createMediaFileService({ db, root });
    const id = seedItem('audio', {
      contentHash: hash('9'),
      mimeType: 'audio/mpeg',
      kind: 'content_addressed',
    });
    // No blob written → no file to pin → a plain not-found, never a throw.
    expect(service.resolve(id)).toBeNull();
  });

  it('returns null for non-playable media (document/message) WITHOUT resolving an original', () => {
    const service = createMediaFileService({ db, root });
    for (const mediaType of ['document', 'message'] as const) {
      const id = seedItem(mediaType, { contentHash: null, kind: 'none' });
      expect(service.resolve(id)).toBeNull();
    }
  });

  it('returns null for an unknown id (no row) without throwing', () => {
    const service = createMediaFileService({ db, root });
    expect(service.resolve('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('returns null when the memory has no surviving original', () => {
    const service = createMediaFileService({ db, root });
    const id = seedItem('audio', { contentHash: null, kind: 'none' });
    expect(service.resolve(id)).toBeNull();
  });

  it('REJECTS a stored content hash that would escape the library root (path containment)', () => {
    const service = createMediaFileService({ db, root });
    // A hostile content-addressing field that is NOT a canonical hash: the
    // originals-store confinement must refuse it before any path is handed out.
    const id = seedItem('video', {
      contentHash: '../../../../etc/passwd',
      mimeType: 'video/mp4',
      kind: 'content_addressed',
    });
    expect(() => service.resolve(id)).toThrow(ERR_ORIGINAL_PATH_ESCAPE);
  });

  it('makes NO network call while resolving a memory (AC-4)', () => {
    const spies = installEgressSpies();
    try {
      writeBlob(root, hash('e'), '.bin', Buffer.from('bytes'));
      const service = createMediaFileService({ db, root });
      const id = seedItem('audio', {
        contentHash: hash('e'),
        mimeType: 'audio/mpeg',
        kind: 'content_addressed',
      });
      closeDescriptor(service.resolve(id));
      spies.assertNoEgress();
    } finally {
      spies.restore();
    }
  });

  // ── In-place SERVE-TIME confinement (§2.4 / the 🔴 fix) ───────────────────
  // Content-addressed originals live UNDER the library root (assertWithinRoot,
  // above). In-place originals are the user's OWN files in a watched folder — they
  // legitimately live OUTSIDE the library, so import-time validation alone leaves a
  // TOCTOU: a later symlink swap at the same recorded path would stream the target's
  // raw bytes into the untrusted renderer. The service must therefore realpath the
  // file at SERVE time and confine it to a registered source root.
  describe('in-place serve-time confinement', () => {
    function seedInPlace(mediaType: MediaType, srcId: string, path: string): string {
      const id = repo.insertItem({ mediaType, mimeType: 'video/mp4', originalExt: '.mp4' });
      repo.addOccurrence({
        itemId: id,
        sourceId: srcId,
        sourceRef: `ref/${id}`,
        originalKind: 'in_place',
        originalPath: path,
      });
      return id;
    }

    it('serves a legit in-place file that lives inside its registered source root', () => {
      const sourceDir = join(root, 'watched');
      mkdirSync(sourceDir, { recursive: true });
      const file = join(sourceDir, 'voice.mp4');
      writeFileSync(file, Buffer.from('a loved one'));
      const srcId = repo.registerSource({
        sourceKey: 'w1',
        type: 'folder',
        label: 'Watched',
        originPath: sourceDir,
        rootPath: sourceDir,
      });
      const id = seedInPlace('video', srcId, file);

      const descriptor = createMediaFileService({ db, root }).resolve(id);
      expect(descriptor).not.toBeNull();
      // A pinned fd on the validated regular file, sized from its fstat.
      expect(typeof descriptor?.fd).toBe('number');
      expect(fstatSync(descriptor?.fd ?? -1).isFile()).toBe(true);
      expect(descriptor?.size).toBe('a loved one'.length);
      closeDescriptor(descriptor);
    });

    it('PINS the fd so a swap of the validated path after resolution cannot redirect the read (TOCTOU)', async () => {
      const sourceDir = join(root, 'watchedT');
      const outsideDir = join(root, 'outsideT');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const srcId = repo.registerSource({
        sourceKey: 'wt',
        type: 'folder',
        label: 'WatchedT',
        originPath: sourceDir,
        rootPath: sourceDir,
      });
      const clip = join(sourceDir, 'clip.mp4');
      writeFileSync(clip, Buffer.from('ORIGINAL-VALIDATED-BYTES'));
      const id = seedInPlace('video', srcId, clip);

      const service = createMediaFileService({ db, root });
      // The adversary swaps the validated path to a DIFFERENT inode (a secret file)
      // in the gap AFTER the service validated it — exactly the validate-then-reopen
      // race. A path-based re-open would now stream the secret; a pinned fd must not.
      const handler = createMediaProtocolHandler({
        resolve: (mediaId) => {
          const descriptor = service.resolve(mediaId); // realpath + containment + OPEN (pin)
          const secret = join(outsideDir, 'secret.mp4');
          writeFileSync(secret, Buffer.from('SECRET-SWAPPED-BYTES!!'));
          renameSync(secret, clip); // clip now points at the secret inode
          return descriptor;
        },
      });

      const res = await handler({ url: mediaUrl(id), headers: noRangeHeaders() });
      expect(res.status).toBe(200);
      const streamed = Buffer.from(await res.arrayBuffer()).toString();
      // The pinned fd streams the ORIGINAL validated bytes; the secret NEVER leaks.
      expect(streamed).toBe('ORIGINAL-VALIDATED-BYTES');
      expect(streamed).not.toContain('SECRET');
    });

    it('REJECTS an in-place original that is not a regular file (e.g. a directory)', () => {
      const sourceDir = join(root, 'watchedD');
      mkdirSync(sourceDir, { recursive: true });
      const subdir = join(sourceDir, 'a-directory');
      mkdirSync(subdir, { recursive: true });
      const srcId = repo.registerSource({
        sourceKey: 'wd',
        type: 'folder',
        label: 'WatchedD',
        originPath: sourceDir,
        rootPath: sourceDir,
      });
      const id = seedInPlace('video', srcId, subdir);

      expect(() => createMediaFileService({ db, root }).resolve(id)).toThrow(
        ERR_ORIGINAL_PATH_ESCAPE,
      );
    });

    it('serves a file under the SECOND servable root candidate (origin_path), not just the first', () => {
      // root_path is left null; the file lives under origin_path — the resolver must
      // OR across every source-root candidate, not only the first.
      const originDir = join(root, 'chosenFolder');
      mkdirSync(originDir, { recursive: true });
      const file = join(originDir, 'clip.mp4');
      writeFileSync(file, Buffer.from('second-root'));
      const srcId = repo.registerSource({
        sourceKey: 'w2r',
        type: 'folder',
        label: 'SecondRoot',
        originPath: originDir,
        // rootPath deliberately omitted (null) → only origin_path can allow it.
      });
      const id = seedInPlace('video', srcId, file);

      const descriptor = createMediaFileService({ db, root }).resolve(id);
      expect(descriptor).not.toBeNull();
      expect(descriptor?.size).toBe('second-root'.length);
      closeDescriptor(descriptor);
    });

    it('REJECTS an in-place path whose realpath ESCAPES the source root (symlink swap — TOCTOU)', () => {
      const sourceDir = join(root, 'watched2');
      const outsideDir = join(root, 'outside2');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const secret = join(outsideDir, 'secret.bin');
      writeFileSync(secret, Buffer.from('SECRET-BYTES'));
      // The recorded path sits inside the source root, but is now a symlink to a
      // file OUTSIDE it — exactly the swap import-time validation cannot catch.
      const link = join(sourceDir, 'voice.mp4');
      symlinkSync(secret, link);
      const srcId = repo.registerSource({
        sourceKey: 'w2',
        type: 'folder',
        label: 'Watched2',
        originPath: sourceDir,
        rootPath: sourceDir,
      });
      const id = seedInPlace('video', srcId, link);

      expect(() => createMediaFileService({ db, root }).resolve(id)).toThrow(
        ERR_ORIGINAL_PATH_ESCAPE,
      );
    });

    it('REJECTS an in-place path recorded OUTSIDE every registered source root', () => {
      const sourceDir = join(root, 'watched3');
      const outsideDir = join(root, 'outside3');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const stray = join(outsideDir, 'stray.mp4');
      writeFileSync(stray, Buffer.from('x'));
      const srcId = repo.registerSource({
        sourceKey: 'w3',
        type: 'folder',
        label: 'Watched3',
        originPath: sourceDir,
        rootPath: sourceDir,
      });
      const id = seedInPlace('video', srcId, stray);

      expect(() => createMediaFileService({ db, root }).resolve(id)).toThrow(
        ERR_ORIGINAL_PATH_ESCAPE,
      );
    });

    it('end to end: streams a legit in-place file (200) but 404s a symlink-escape with ZERO bytes', async () => {
      const sourceDir = join(root, 'watchedE');
      const outsideDir = join(root, 'outsideE');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const srcId = repo.registerSource({
        sourceKey: 'we',
        type: 'folder',
        label: 'WatchedE',
        originPath: sourceDir,
        rootPath: sourceDir,
      });

      const good = join(sourceDir, 'clip.mp4');
      writeFileSync(good, Buffer.from('HELLO-CLIP'));
      const goodId = seedInPlace('video', srcId, good);

      const secret = join(outsideDir, 'passwd');
      writeFileSync(secret, Buffer.from('SECRET-BYTES'));
      const evilLink = join(sourceDir, 'evil.mp4');
      symlinkSync(secret, evilLink);
      const evilId = seedInPlace('video', srcId, evilLink);

      const service = createMediaFileService({ db, root });
      const handler = createMediaProtocolHandler({ resolve: (id) => service.resolve(id) });

      const ok = await handler({ url: mediaUrl(goodId), headers: noRangeHeaders() });
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('HELLO-CLIP');

      const blocked = await handler({ url: mediaUrl(evilId), headers: noRangeHeaders() });
      expect(blocked.status).toBe(404);
      expect((await blocked.arrayBuffer()).byteLength).toBe(0);
    });
  });
});

describe('isServablePath — realpath allowlist (§2.4)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('servable');
  });
  afterEach(() => {
    removeTmpDir(root);
  });

  it('allows a real file contained within a servable root', () => {
    const dir = join(root, 'src');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'a.mp4');
    writeFileSync(file, Buffer.from('x'));
    expect(isServablePath(file, [dir])).toBe(true);
  });

  it('allows a path byte-equal to a servable root entry (single-file selection)', () => {
    const file = join(root, 'single.mp4');
    writeFileSync(file, Buffer.from('x'));
    expect(isServablePath(file, [file])).toBe(true);
  });

  it('rejects a symlink whose realpath escapes every servable root', () => {
    const dir = join(root, 'src2');
    const out = join(root, 'out2');
    mkdirSync(dir, { recursive: true });
    mkdirSync(out, { recursive: true });
    const secret = join(out, 'secret');
    writeFileSync(secret, Buffer.from('S'));
    const link = join(dir, 'link.mp4');
    symlinkSync(secret, link);
    expect(isServablePath(link, [dir])).toBe(false);
  });

  it('rejects a file outside every servable root, and a missing path', () => {
    const dir = join(root, 'src3');
    const out = join(root, 'out3');
    mkdirSync(dir, { recursive: true });
    mkdirSync(out, { recursive: true });
    const stray = join(out, 'stray');
    writeFileSync(stray, Buffer.from('S'));
    expect(isServablePath(stray, [dir])).toBe(false);
    expect(isServablePath(join(dir, 'ghost.mp4'), [dir])).toBe(false);
  });

  it('rejects when the servable-roots allowlist is empty', () => {
    const file = join(root, 'x.mp4');
    writeFileSync(file, Buffer.from('x'));
    expect(isServablePath(file, [])).toBe(false);
  });

  it('IGNORES an empty-string or non-absolute root entry (never "allow anything under cwd")', () => {
    // An empty root would realpath to process.cwd(); a relative root is likewise
    // ambiguous. The primitive itself must reject both — not rely on a pre-filter.
    const file = join(root, 'y.mp4');
    writeFileSync(file, Buffer.from('x'));
    // A file under cwd, gated ONLY by an empty / relative root → must stay refused.
    const underCwd = join(process.cwd(), 'package.json');
    expect(isServablePath(underCwd, [''])).toBe(false);
    expect(isServablePath(underCwd, ['.'])).toBe(false);
    expect(isServablePath(underCwd, ['node_modules'])).toBe(false);
    // And a legit absolute root still works alongside a junk entry.
    expect(isServablePath(file, ['', root])).toBe(true);
  });

  it('allows a file under the SECOND servable root when the first does not match (OR logic)', () => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const file = join(second, 'clip.mp4');
    writeFileSync(file, Buffer.from('x'));
    expect(isServablePath(file, [first, second])).toBe(true);
  });
});

describe('pinRegularFile — O_NOFOLLOW refuses a symlink planted in the realpath→open window (CWE-367)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('pin-nofollow');
  });
  afterEach(() => {
    removeTmpDir(root);
  });

  it('REFUSES to follow a symlink at the canonical path (the realpath→open race must not leak an out-of-root file)', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    const secret = join(outside, 'secret');
    writeFileSync(secret, Buffer.from('SECRET-OUT-OF-ROOT'));
    // Simulate the race: between realpath resolving the canonical path and the open,
    // an attacker replaced that exact path with a symlink to a file outside the roots.
    const canonical = join(root, 'canonical.mp4');
    symlinkSync(secret, canonical);

    const result = pinRegularFile(canonical, 'in_place');
    // With O_NOFOLLOW the open fails (ELOOP) → null; the secret fd is NEVER pinned.
    if (result !== null) closeSync(result.fd); // never leak, even on the vulnerable path
    expect(result).toBeNull();
  });

  it('still pins a legit regular file (serveable) and reports its fstat size', () => {
    const file = join(root, 'clip.mp4');
    writeFileSync(file, Buffer.from('twelve bytes'));

    const result = pinRegularFile(file, 'in_place');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('in_place');
    expect(result?.size).toBe('twelve bytes'.length);
    expect(fstatSync(result?.fd ?? -1).isFile()).toBe(true);
    if (result !== null) closeSync(result.fd);
  });
});

describe('media open flags — O_NONBLOCK prevents a main-thread hang on a FIFO/device (CWE-400)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('media-fifo');
  });
  afterEach(() => {
    removeTmpDir(root);
  });

  it('opens read-only, refuses to follow a symlink (O_NOFOLLOW), AND never blocks (O_NONBLOCK)', () => {
    // The complete secure-open recipe. Read-only: neither write access-mode bit is
    // set. On POSIX O_NOFOLLOW + O_NONBLOCK must also be set; on Windows they are
    // absent and degrade to 0 (minimal surface).
    expect(MEDIA_OPEN_FLAGS & fsConstants.O_WRONLY).toBe(0);
    expect(MEDIA_OPEN_FLAGS & fsConstants.O_RDWR).toBe(0);
    if (process.platform !== 'win32') {
      expect(MEDIA_OPEN_FLAGS & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
      // The missing piece: without O_NONBLOCK a writer-less FIFO hangs the open.
      expect(MEDIA_OPEN_FLAGS & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    }
  });

  // The behavioural proof runs the (potentially blocking) open in a CHILD process we
  // can time out — so a regression that drops O_NONBLOCK fails as a killed child
  // rather than hanging the whole suite. It opens a writer-less FIFO with the REAL
  // exported MEDIA_OPEN_FLAGS and asserts it returns PROMPTLY and sees a non-regular
  // file (which pinRegularFile's fstat gate then rejects → 404).
  it.skipIf(process.platform === 'win32')(
    'opening a writer-less FIFO with MEDIA_OPEN_FLAGS returns promptly and is detected non-regular',
    () => {
      const fifo = join(root, 'pipe.mp4');
      execFileSync('mkfifo', [fifo]);
      const script = [
        'const fs=require("fs");',
        'let fd;',
        'try{fd=fs.openSync(process.argv[1],Number(process.argv[2]));}',
        'catch(e){process.stdout.write("CAUGHT:"+e.code);process.exit(0);}',
        'const st=fs.fstatSync(fd);fs.closeSync(fd);',
        'process.stdout.write("OPENED:isFile="+st.isFile());',
      ].join('');
      const child = spawnSync(process.execPath, ['-e', script, fifo, String(MEDIA_OPEN_FLAGS)], {
        timeout: 4000,
        encoding: 'utf8',
      });
      // A blocking open (no O_NONBLOCK) would be KILLED by the timeout → signal set.
      // With O_NONBLOCK the child returns on its own → signal null.
      expect(child.signal).toBeNull();
      expect(child.stdout).toContain('isFile=false');
    },
  );
});
