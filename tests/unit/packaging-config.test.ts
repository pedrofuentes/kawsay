import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FUSE_CONFIG } from '../../electron/fuses/fuses';
import {
  SUPPORTED_WHISPER_TARGETS,
  WHISPER_CLI_RESOURCE_SUBDIR,
} from '../../electron/main/transcription/whisper-cli';
import {
  EMBED_RESOURCE_SUBDIR,
  SUPPORTED_EMBED_TARGETS,
} from '../../electron/main/search/embed-cli';
import {
  MEDIA_RESOURCE_SUBDIR,
  SUPPORTED_MEDIA_TARGETS,
} from '../../electron/main/importers/deps/media-binaries';

// The electron-builder packaging contract for AC-5 (ADR-0007, ARCHITECTURE §8).
// These assertions pin the load-bearing packaging invariants — the native-module
// unpack rules (without which the packaged app crashes on first DB open), the
// macOS/Windows targets, the unsigned-v1 posture, the security-fuse flip, and the
// zero-egress / human-required-publish boundary — so they cannot silently regress.
const repoRoot = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const builderYml = readFileSync(repoRoot('electron-builder.yml'), 'utf8');

/**
 * Strip YAML comments (`# …`) so the assertions below test the actual
 * configuration, not the explanatory prose — which legitimately names what we
 * deliberately omit (e.g. the line stating we bundle "no electron-updater/
 * autoUpdater"). `builderConfig` is the comment-free view used by those checks.
 *
 * Splits on CRLF *or* LF (`/\r?\n/`) so the strip works on a Windows (CRLF)
 * checkout too: with a plain `.split('\n')` every line keeps a trailing `\r`,
 * and the regex (no `m` flag; `.` excludes `\r`; `$` = end-of-string) then
 * never matches the comment, leaking the prose into the "config" under test.
 */
function stripYamlComments(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}
const builderConfig = stripYamlComments(builderYml);
const packageJson = JSON.parse(readFileSync(repoRoot('package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  pnpm?: { onlyBuiltDependencies?: string[] };
};

// The release automation harness (.github/workflows/release.yml) is the other half
// of the AC-5 packaging contract (ADR-0007), so this drift test guards it too.
// #122: the macOS + Windows matrix legs each ran `electron-builder --publish always`
// and RACED to create the GitHub Release, producing two split/duplicate releases
// (each carrying only its own platform's assets). The assertions below pin the
// race-free shape — a build-only OS matrix that uploads artifacts plus a SINGLE,
// human-gated publish job that downloads them and creates exactly ONE release —
// so the race cannot silently regress.
// Normalize CRLF→LF once at read so the `\n`-based regex assertions below match
// on a Windows (CRLF) checkout too. Without this, e.g. `permissions:\r\n  contents:
// read` fails `/permissions:\n {2}contents: read/` only on windows-latest CI (#169).
const releaseYml = readFileSync(repoRoot('.github/workflows/release.yml'), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const ciYml = readFileSync(repoRoot('.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

// The llama-embedding build script itself (not just its CI wiring) is part of the
// packaging contract: it must build the engine NETWORK-FREE so no TLS/HTTP/curl
// code is compiled into the shipped binary (AC-4 zero-egress).
const embedBuildScript = readFileSync(repoRoot('scripts/build-embed-cli.sh'), 'utf8');

// The maintainer-gated embedder-model publish workflow (.github/workflows/
// publish-embed-model.yml) converts + uploads the M4 embedder GGUF. Its "Install
// Python conversion deps" step must be supply-chain reproducible: the llama.cpp
// requirements file it installs is already pinned, but huggingface_hub (the model
// download) and the pip self-upgrade were UNPINNED (#233, from Sentinel PR #232 Dim
// E) — a future compromised/regressed huggingface_hub or pip could silently change
// the produced bytes (hence the SHA-256 the descriptor pins). Normalize CRLF→LF once
// (Windows-checkout safe) as with the other workflow reads.
const publishEmbedModelYml = readFileSync(
  repoRoot('.github/workflows/publish-embed-model.yml'),
  'utf8',
).replace(/\r\n/g, '\n');

/** Return the body lines of a `jobs:` entry (a 2-space-indented id) by job id. */
function releaseJobBlock(jobId: string): string {
  const lines = releaseYml.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^ {2}${jobId}:\\s*$`).test(l));
  if (start === -1) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && /^ {0,2}\S/.test(line)) break; // next job or top-level key
    body.push(line);
  }
  return body.join('\n');
}

/** Every `uses:` line in the workflow (for the SHA-pin assertions). */
const releaseUsesLines = releaseYml.split(/\r?\n/).filter((l) => /^\s*uses:/.test(l));

/** Return the body lines of a ci.yml `jobs:` entry (a 2-space-indented id) by job id. */
function ciJobBlock(jobId: string): string {
  const lines = ciYml.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^ {2}${jobId}:\\s*$`).test(l));
  if (start === -1) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && /^ {0,2}\S/.test(line)) break; // next job or top-level key
    body.push(line);
  }
  return body.join('\n');
}

/** Every `uses:` line in the CI workflow (for the SHA-pin assertions). */
const ciUsesLines = ciYml.split(/\r?\n/).filter((l) => /^\s*uses:/.test(l));

function escapedRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assetPathRegex(...parts: string[]): RegExp {
  return new RegExp(parts.map(escapedRegexLiteral).join(String.raw`[\\/]`));
}

/** Return the indented body lines that belong to a top-level YAML key. */
function topLevelBlock(name: string): string {
  const lines = builderYml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (start === -1) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (/^\S/.test(line)) break; // next top-level key
    body.push(line);
  }
  return body.join('\n');
}

/** Parse a flat `key: true|false` map from a top-level YAML block. */
function parseFlatBooleanBlock(name: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const line of topLevelBlock(name).split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+):\s*(true|false)\s*$/.exec(line);
    if (m) out[m[1]] = m[2] === 'true';
  }
  return out;
}

describe('electron-builder packaging contract (AC-5, ADR-0007)', () => {
  it('declares the app identity and product metadata', () => {
    expect(builderYml).toMatch(/^appId:\s*es\.pedrofuent\.kawsay\s*$/m);
    expect(builderYml).toMatch(/^productName:\s*Kawsay\s*$/m);
    expect(builderYml).toMatch(/^copyright:/m);
  });

  it('unpacks the native catalog engine from the asar (media binaries ship as extraResources)', () => {
    // A compiled `.node` cannot be dlopen'd from inside an asar, so better-sqlite3
    // lives in app.asar.unpacked (ADR-0007). The ffmpeg/ffprobe binaries are NOT in
    // node_modules — they ship as out-of-asar extraResources (#175), so the broken
    // ffmpeg-static / ffprobe-static packages must not be referenced anywhere here.
    const unpack = topLevelBlock('asarUnpack');
    expect(unpack).toMatch(/node_modules\/better-sqlite3\//);
    expect(builderYml).not.toMatch(/ffmpeg-static/);
    expect(builderYml).not.toMatch(/ffprobe-static/);
  });

  it('rebuilds native modules against the Electron ABI from source', () => {
    expect(builderYml).toMatch(/^npmRebuild:\s*true\s*$/m);
    expect(builderYml).toMatch(/^buildDependenciesFromSource:\s*true\s*$/m);
  });

  it('does not depend on the standalone @electron/rebuild supply-chain path', () => {
    // electron-builder owns the production rebuild using its app-scoped rebuild
    // pipeline. Keeping the standalone CLI in devDependencies/scripts widens the
    // native-install supply chain and is unsafe in nested worktrees (#46).
    expect(packageJson.devDependencies ?? {}).not.toHaveProperty('@electron/rebuild');
    expect(packageJson.scripts).not.toHaveProperty('rebuild:native');
  });

  it('tracks the only dependency allowed to run native install scripts', () => {
    expect(packageJson.pnpm?.onlyBuiltDependencies).toEqual(['better-sqlite3']);
  });

  it('targets macOS .dmg + .zip (arm64 + x64) and ships unsigned in v1', () => {
    const mac = topLevelBlock('mac');
    expect(mac).toMatch(/target:\s*dmg/);
    expect(mac).toMatch(/target:\s*zip/);
    expect(mac).toMatch(/arm64/);
    expect(mac).toMatch(/x64/);
    expect(mac).toMatch(/identity:\s*null/); // unsigned v1 (signing deferred)
  });

  it('targets Windows NSIS .exe (x64 only in v1)', () => {
    const win = topLevelBlock('win');
    expect(win).toMatch(/target:\s*nsis/);
    expect(win).toMatch(/x64/);
    expect(win).not.toMatch(/arm64/); // win-arm64 deferred (ADR-0007)
  });

  it('flips the declared security fuses to match FUSE_CONFIG (asar-integrity deferred to signing)', () => {
    // Drift guard: the packaged posture (electron-builder electronFuses) must match the
    // reviewed declaration in electron/fuses/fuses.ts (ARCHITECTURE §2.5) — with ONE
    // deliberate v1 exception. enableEmbeddedAsarIntegrityValidation requires macOS code
    // signing to work; on the UNSIGNED v1 build it makes the renderer fail to load from
    // the asar (ERR_FILE_NOT_FOUND). v1 ships it OFF and the cofounder re-enables it with
    // Developer ID signing/notarization (ADR-0025).
    const flipped = parseFlatBooleanBlock('electronFuses');
    const SIGNING_GATED = 'enableEmbeddedAsarIntegrityValidation';
    for (const [key, value] of Object.entries(FUSE_CONFIG)) {
      if (key === SIGNING_GATED) continue;
      expect(flipped[key]).toBe(value);
    }
    expect(FUSE_CONFIG.enableEmbeddedAsarIntegrityValidation).toBe(true); // declared target
    expect(flipped[SIGNING_GATED]).toBe(false); // unsigned v1 build defers it until signing
  });

  it('pins better-sqlite3 at an Electron-42-compatible version (native build floor)', () => {
    // better-sqlite3 < 12.10.1 fails to compile against Electron 42's V8 (v8::External
    // gained a required `tag` argument); 12.11.1 additionally fixes the Windows build.
    // Vitest loads the Node-ABI prebuilt, which hides this — it can only regress at
    // package time, so pin the floor here so a downgrade can't silently break `pnpm dist`.
    const version = (packageJson.dependencies?.['better-sqlite3'] ?? '').replace(/^[\D]*/, '');
    const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const compatible = major > 12 || (major === 12 && (minor > 11 || (minor === 11 && patch >= 1)));
    expect(compatible, `better-sqlite3 "${version}" predates Electron 42 support`).toBe(true);
  });

  it('re-applies the ad-hoc macOS signature after flipping fuses', () => {
    // Without this, flipping fuses invalidates the signature and the UNSIGNED v1
    // build will not launch on Apple Silicon (arm64 requires a valid signature).
    expect(parseFlatBooleanBlock('electronFuses').resetAdHocDarwinSignature).toBe(true);
  });
});

describe('whisper-cli engine bundling contract (#129, ADR-0027)', () => {
  // The whisper.cpp `whisper-cli` (MIT) is built FROM SOURCE per-arch in CI
  // (scripts/build-whisper-cli.sh) and bundled as an out-of-asar extraResource,
  // so the packaged app spawns it via process.resourcesPath — resolved by
  // electron/main/transcription/whisper-cli.ts. These assertions pin that
  // packaging contract so it cannot silently drift from the resolver.
  const extra = topLevelBlock('extraResources');

  it('bundles a per-arch whisper-cli as an out-of-asar extraResource', () => {
    // A native executable cannot be spawned from inside an asar (same constraint
    // as ffmpeg/ffprobe), so it travels in Resources, copied from the per-arch
    // build output into <resources>/whisper/<os>-<arch>/.
    expect(extra).toMatch(assetPathRegex('resources', 'whisper', '${os}-${arch}'));
    expect(extra).toMatch(assetPathRegex('whisper', '${os}-${arch}'));
    expect('from: resources\\whisper\\${os}-${arch}').toMatch(
      assetPathRegex('resources', 'whisper', '${os}-${arch}'),
    );
  });

  it('parameterizes the bundle per build leg via the ${os}-${arch} macros (each shipped arch)', () => {
    // One macro'd entry that electron-builder expands to a binary per build leg —
    // macOS arm64 + x64, Windows x64 — so each installer carries exactly its own
    // arch's whisper-cli and no other. The resolver's shipped-target set is the
    // cartesian product of those legs; keep the two in lock-step here.
    expect(extra).toContain('${os}');
    expect(extra).toContain('${arch}');
    expect([...SUPPORTED_WHISPER_TARGETS].sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
  });

  it('keeps the resolver bundle sub-directory in lock-step with the extraResource `to:`', () => {
    // electron/main/transcription/whisper-cli.ts resolves
    // <resourcesPath>/<subdir>/<os>-<arch>/whisper-cli[.exe]; the `to:` sub-dir
    // here MUST equal that constant or the packaged app can't find the binary.
    expect(WHISPER_CLI_RESOURCE_SUBDIR).toBe('whisper');
    expect(extra).toMatch(
      new RegExp(`to:\\s*'?${escapedRegexLiteral(WHISPER_CLI_RESOURCE_SUBDIR)}[\\\\/]`),
    );
  });

  it('ships NO model alongside the binary (the ggml model is a separate opt-in download)', () => {
    // ADR-0027 Decision 6: only the BINARY is bundled here; the ~466 MiB `small`
    // ggml model is fetched on opt-in (cards #130/#131), never in the installer.
    expect(extra).not.toMatch(/ggml|\.bin\b|model/i);
  });
});

describe('ffmpeg + ffprobe media-binary bundling contract (#175)', () => {
  // v0.2.0 shipped NO ffmpeg (pnpm blocked ffmpeg-static's download postinstall)
  // and a wrong-arch ffprobe (ffprobe-static@3.1.0 mislabeled its darwin/arm64
  // binary as x86_64), breaking all audio extraction + thumbnails. The binaries
  // now ship per-arch as out-of-asar extraResources, staged from the
  // @ffmpeg-installer / @ffprobe-installer packages by stage-media-binaries.mjs
  // and resolved at runtime by electron/main/importers/deps/media-binaries.ts.
  // These assertions pin that packaging contract so it cannot silently drift.
  const extra = topLevelBlock('extraResources');

  it('bundles per-arch ffmpeg + ffprobe as out-of-asar extraResources', () => {
    // A native executable cannot be spawned from inside an asar (same constraint as
    // whisper-cli), so the binaries travel in Resources, copied per-arch into
    // <resources>/media/<os>-<arch>/.
    expect(extra).toMatch(assetPathRegex('resources', 'media', '${os}-${arch}'));
    expect(extra).toMatch(assetPathRegex('media', '${os}-${arch}'));
    expect('from: resources\\media\\${os}-${arch}').toMatch(
      assetPathRegex('resources', 'media', '${os}-${arch}'),
    );
  });

  it('parameterizes the bundle per build leg via the ${os}-${arch} macros (each shipped arch)', () => {
    // One macro'd entry that electron-builder expands per build leg — macOS arm64 +
    // x64, Windows x64 — so each installer carries exactly its own-arch ffmpeg +
    // ffprobe and no other, the same cross-arch-safe pattern as whisper-cli.
    expect(extra).toContain('${os}');
    expect(extra).toContain('${arch}');
    expect([...SUPPORTED_MEDIA_TARGETS].sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
  });

  it('keeps the resolver bundle sub-directory in lock-step with the extraResource `to:`', () => {
    // electron/main/importers/deps/media-binaries.ts resolves
    // <resourcesPath>/<subdir>/<os>-<arch>/<ffmpeg|ffprobe>[.exe]; the `to:` sub-dir
    // here MUST equal that constant or the packaged app can't find the binaries.
    expect(MEDIA_RESOURCE_SUBDIR).toBe('media');
    expect(extra).toMatch(
      new RegExp(`to:\\s*'?${escapedRegexLiteral(MEDIA_RESOURCE_SUBDIR)}[\\\\/]`),
    );
  });
});

describe('packaging preserves zero-egress + the human-required publish gate (AC-4/AC-5)', () => {
  it('never publishes from the automated `pnpm dist` build', () => {
    // Publishing to GitHub Releases is HUMAN-REQUIRED (protected Environment). The
    // automated/local build must never upload a release, so `dist` forces --publish never.
    expect(packageJson.scripts.dist).toMatch(/--publish\s+never/);
  });

  it('bundles no auto-updater / update feed (local-only, AC-4)', () => {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    expect(Object.keys(deps)).not.toContain('electron-updater');
    expect(builderConfig).not.toMatch(/autoUpdater/);
  });
});

describe('stripYamlComments tolerates CRLF and LF line endings (Windows-checkout safe)', () => {
  // A Windows checkout (no `.gitattributes` renormalization) yields CRLF (`\r\n`)
  // line endings, so each comment line carries a trailing `\r`. The strip must
  // still remove `#` comments, otherwise a `\r`-terminated comment survives and a
  // contract assertion (e.g. "no autoUpdater") fails only on Windows CI. Each
  // comment line is followed by another line so it carries that trailing `\r`
  // under CRLF — the exact condition the old `.split('\n')` could not strip.
  const lines = [
    'publish:',
    '  provider: github',
    '# Kawsay bundles no electron-updater/autoUpdater feed (prose, not config)',
    '  releaseType: release # inline telemetry note',
    '  owner: pedrofuentes',
  ];

  it('strips full-line and inline comments from a CRLF document', () => {
    const stripped = stripYamlComments(lines.join('\r\n'));
    // These two FAIL on the old `.split('\n')`: the trailing `\r` left the
    // comment unmatched, so the prose words leaked into the stripped config.
    expect(stripped).not.toMatch(/autoUpdater/);
    expect(stripped).not.toMatch(/telemetry/);
    // Real configuration must survive the strip on CRLF input.
    expect(stripped).toMatch(/provider: github/);
    expect(stripped).toMatch(/releaseType: release/);
  });

  it('strips the same comments from an LF document (parity)', () => {
    const stripped = stripYamlComments(lines.join('\n'));
    expect(stripped).not.toMatch(/autoUpdater/);
    expect(stripped).not.toMatch(/telemetry/);
    expect(stripped).toMatch(/provider: github/);
    expect(stripped).toMatch(/releaseType: release/);
  });
});

describe('release workflow publishes ONE consolidated GitHub Release — no publish race (#122)', () => {
  const build = releaseJobBlock('build');
  const publish = releaseJobBlock('publish');

  it('builds the OS matrix with --publish never and never with --publish always', () => {
    // The v0.1.0 race was two matrix legs each running `--publish always`. The build
    // legs now only BUILD; nothing in the workflow publishes via electron-builder.
    expect(releaseYml).toMatch(/electron-builder --publish never/);
    expect(releaseYml).not.toMatch(/--publish always/);
  });

  it('runs the macOS+Windows matrix on the build job and publishes from a single non-matrix job', () => {
    expect(build).toMatch(/matrix:/);
    expect(build).toMatch(/os:\s*\[\s*macos-latest\s*,\s*windows-latest\s*\]/);
    // The publisher must run exactly once — no matrix/strategy fan-out, hence no race.
    expect(publish).not.toMatch(/matrix:/);
    expect(publish).not.toMatch(/strategy:/);
    expect(publish).toMatch(/needs:\s*\[\s*build\s*\]/);
  });

  it('creates the release from exactly one SHA-pinned softprops/action-gh-release step', () => {
    const ghRelease = releaseYml.match(/uses:\s*softprops\/action-gh-release@[0-9a-f]{40}/g) ?? [];
    expect(ghRelease).toHaveLength(1); // one publisher → one release
    expect(publish).toMatch(
      /uses:\s*softprops\/action-gh-release@[0-9a-f]{40}\s*#\s*v\d+\.\d+\.\d+/,
    );
  });

  it('hands platform installers from the build legs to the publish job via artifacts', () => {
    expect(build).toMatch(/uses:\s*actions\/upload-artifact@[0-9a-f]{40}/);
    expect(publish).toMatch(/uses:\s*actions\/download-artifact@[0-9a-f]{40}/);
  });

  it('uploads and verifies update metadata by release channel instead of hard-coding latest (#172)', () => {
    // Stable releases use latest.yml/latest-mac.yml, but prerelease tags such as
    // v1.2.3-beta.1 produce beta.yml/beta-mac.yml. The release guard must derive
    // and validate the channel from the tag, otherwise prereleases fail closed only
    // after the human-gated publish job starts.
    expect(build).toMatch(/dist\/\*\.yml/);
    expect(publish).toMatch(/channel="\$\{tag#\*-\}"/);
    expect(publish).toMatch(/channel="\$\{channel%%\.\*\}"/);
    expect(publish).toMatch(/latest\|alpha\|beta\|rc/);
    expect(publish).toMatch(/"\$\{channel\}-mac\.yml"/);
    expect(publish).toMatch(/"\$\{channel\}\.yml"/);
    expect(publish).not.toMatch(/\[ -f latest-mac\.yml \]/);
    expect(publish).not.toMatch(/\[ -f latest\.yml \]/);
  });

  it('passes the resolved tag into shell via env instead of interpolating it in a run block', () => {
    // The publish job has contents: write. A tag like `v1.2.3-rc.1"; curl ...; "`
    // must be data in "$TAG", never workflow-expression text spliced into bash.
    expect(publish).toMatch(/env:\n(?: {10}.+\n)* {10}TAG: \$\{\{ steps\.tag\.outputs\.tag \}\}/);
    expect(publish).toMatch(/tag="\$TAG"/);
    expect(publish).not.toMatch(/tag="\$\{\{ steps\.tag\.outputs\.tag \}\}"/);
  });

  it('keeps the protected `release` environment human gate on the single publish job only', () => {
    expect(publish).toMatch(/environment:\s*release/);
    expect(build).not.toMatch(/environment:\s*release/); // build legs do not publish
    // The required-reviewer gate guards exactly one job — the one that publishes.
    expect(releaseYml.match(/environment:\s*release/g)).toHaveLength(1);
  });

  it('grants contents: write only to the publish job and stays read-only at the top level', () => {
    expect(publish).toMatch(/contents:\s*write/);
    expect(build).not.toMatch(/contents:\s*write/); // build legs upload artifacts, not releases
    expect(releaseYml).toMatch(/permissions:\n {2}contents: read/); // top-level least privilege
  });
});

describe('release workflow preserves the M1 hardening + whisper-cli build (#129, ADR-0007/0025/0027)', () => {
  const build = releaseJobBlock('build');

  it('SHA-pins every action to a 40-hex commit with a # vX.Y.Z comment', () => {
    expect(releaseUsesLines.length).toBeGreaterThan(0);
    for (const line of releaseUsesLines) {
      expect(line).toMatch(/uses:\s*[^@\s]+@[0-9a-f]{40}\s*#\s*v\d+\.\d+\.\d+/);
    }
  });

  describe('CI workflow preserves media-binary hardening (#178/#182)', () => {
    const verify = (() => {
      const lines = ciYml.split(/\r?\n/);
      const start = lines.findIndex((l) => /^ {2}verify:\s*$/.test(l));
      if (start === -1) return '';
      const body: string[] = [];
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() !== '' && /^ {0,2}\S/.test(line)) break;
        body.push(line);
      }
      return body.join('\n');
    })();

    it('builds macOS media binaries from source before staging and verifying them', () => {
      expect(verify).toMatch(/if:\s*runner\.os == 'macOS'/);
      expect(verify).toMatch(/\.\/scripts\/build-ffmpeg\.sh/);
      expect(verify).toMatch(/pnpm stage:media/);
      expect(verify).toMatch(/scripts\/verify-media-binaries\.mjs/);
    });

    it('pins the nasm assembler floor in CI so source ffmpeg builds are reproducible', () => {
      expect(verify).toMatch(/NASM_MIN_VERSION:\s*[0-9]+\.[0-9]+\.[0-9]+/);
    });
  });

  it('builds + verifies the per-arch whisper-cli before packaging', () => {
    expect(build).toMatch(/scripts\/build-whisper-cli\.sh/);
    expect(build).toMatch(/Verify staged binaries/);
    expect(build).toMatch(/resources\/whisper\/mac-arm64\/whisper-cli/);
    expect(build).toMatch(/resources\/whisper\/win-x64\/whisper-cli\.exe/);
  });

  it('stages + verifies the per-arch ffmpeg/ffprobe before packaging (#175)', () => {
    // The build guard that stops the v0.2.0 packaging bug (no ffmpeg; wrong-arch
    // ffprobe) from recurring: stage the correct-arch binaries, then fail the build
    // if any is missing or the wrong arch — BEFORE electron-builder packages them.
    expect(build).toMatch(/pnpm stage:media/);
    expect(build).toMatch(/scripts\/verify-media-binaries\.mjs/);
  });

  it('keeps the unsigned-v1 posture, Node 22, and non-persisted credentials', () => {
    expect(build).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY:\s*'false'/);
    expect(releaseYml).toMatch(/node-version:\s*22/);
    expect(releaseYml).toMatch(/persist-credentials:\s*false/);
  });

  it('still triggers on a pushed v* tag and manual dispatch, serialized by concurrency', () => {
    expect(releaseYml).toMatch(/tags:\s*\n\s*-\s*'v\*'/);
    expect(releaseYml).toMatch(/workflow_dispatch:/);
    expect(releaseYml).toMatch(/concurrency:/);
    expect(releaseYml).toMatch(/cancel-in-progress:\s*false/);
  });
});

describe('embed-cli engine build + bundling contract (M4-1b, ADR-0029)', () => {
  // The llama.cpp `llama-embedding` (MIT) is built FROM SOURCE per-arch in CI
  // (scripts/build-embed-cli.sh) and bundled as an out-of-asar extraResource, so
  // the packaged app spawns it via process.resourcesPath — resolved by
  // electron/main/search/embed-cli.ts. It is the exact sibling of the whisper-cli
  // engine (same build/cache/verify/bundle shape). These assertions pin that
  // packaging contract so it cannot silently drift from the resolver, and prove
  // the addition is ADDITIVE (the whisper-cli job/step/bundle stay intact).
  const extra = topLevelBlock('extraResources');
  const embedJob = ciJobBlock('embed-cli');
  const releaseBuild = releaseJobBlock('build');

  it('bundles a per-arch llama-embedding as an out-of-asar extraResource', () => {
    // A native executable cannot be spawned from inside an asar (same constraint
    // as whisper-cli / ffmpeg), so it travels in Resources, copied from the
    // per-arch build output into <resources>/embed/<os>-<arch>/.
    expect(extra).toMatch(assetPathRegex('resources', 'embed', '${os}-${arch}'));
    expect(extra).toMatch(assetPathRegex('embed', '${os}-${arch}'));
    expect('from: resources\\embed\\${os}-${arch}').toMatch(
      assetPathRegex('resources', 'embed', '${os}-${arch}'),
    );
  });

  it('parameterizes the bundle per build leg via the ${os}-${arch} macros (each shipped arch)', () => {
    // One macro'd entry that electron-builder expands to a binary per build leg —
    // macOS arm64 + x64, Windows x64 — so each installer carries exactly its own
    // arch's llama-embedding. The resolver's shipped-target set is the cartesian
    // product of those legs; keep the two in lock-step here.
    expect(extra).toContain('${os}');
    expect(extra).toContain('${arch}');
    expect([...SUPPORTED_EMBED_TARGETS].sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
  });

  it('keeps the resolver bundle sub-directory in lock-step with the extraResource `to:`', () => {
    // electron/main/search/embed-cli.ts resolves
    // <resourcesPath>/<subdir>/<os>-<arch>/llama-embedding[.exe]; the `to:` sub-dir
    // here MUST equal that constant or the packaged app can't find the binary.
    expect(EMBED_RESOURCE_SUBDIR).toBe('embed');
    expect(extra).toMatch(
      new RegExp(`to:\\s*'?${escapedRegexLiteral(EMBED_RESOURCE_SUBDIR)}[\\\\/]`),
    );
  });

  it('ships ONLY the binary in this slice (no embedding weights / GGUF)', () => {
    // M4-1b binary slice: bundle ONLY the executable; the multilingual-e5-small
    // GGUF is a separate, later opt-in slice, so nothing weights/GGUF-shaped ships
    // in the embed extraResource here.
    expect(extra).not.toMatch(/\.gguf\b/i);
    expect(extra).not.toMatch(/multilingual-e5/i);
  });

  it('CI fans the embed-cli build out to one (os, arch) leg each + runs the arch-checking verify guard', () => {
    // Mirrors the whisper-cli CI job, but the build is fanned out to ONE (os, arch)
    // leg each — macOS arm64, macOS x64, Windows x64 — so the two macOS arches
    // compile in parallel jobs (each with its own timeout budget) instead of
    // back-to-back on one runner, which overran the 60-min timeout. Each leg builds
    // exactly its arch via EMBED_ARCH; Windows has no arm64 leg (excluded).
    expect(embedJob).toMatch(/matrix:/);
    expect(embedJob).toMatch(/os:\s*\[\s*macos-latest\s*,\s*windows-latest\s*\]/);
    expect(embedJob).toMatch(/arch:\s*\[\s*arm64\s*,\s*x64\s*\]/);
    expect(embedJob).toMatch(/exclude:/);
    expect(embedJob).toMatch(/os:\s*windows-latest\s+arch:\s*arm64/);
    // Each leg passes its single arch to BOTH the build script and the verify guard.
    expect(embedJob).toMatch(/EMBED_ARCH:\s*\$\{\{\s*matrix\.arch\s*\}\}/);
    expect(embedJob).toMatch(/scripts\/build-embed-cli\.sh/);
    expect(embedJob).toMatch(/scripts\/verify-embed-binary\.mjs/);
  });

  it('pins llama.cpp by repo + ref + 40-hex commit as the single source of truth (CI env)', () => {
    // The workflow env is the ONE pin location; build-embed-cli.sh reads it and
    // asserts the cloned HEAD == COMMIT, so a re-pointed tag fails the build.
    expect(embedJob).toMatch(/LLAMA_CPP_REPO:\s*ggml-org\/llama\.cpp/);
    expect(embedJob).toMatch(/LLAMA_CPP_REF:\s*\S+/);
    expect(embedJob).toMatch(/LLAMA_CPP_COMMIT:\s*[0-9a-f]{40}/);
  });

  it('keys the CI build cache on the arch + llama.cpp pins + build-script hash', () => {
    // Each (os, arch) leg builds only its own arch into resources/embed, so the
    // cache key MUST include matrix.arch — otherwise the two macOS legs (same
    // runner.os) would collide and one arch could restore the other's cache.
    expect(embedJob).toMatch(
      /key:\s*embed-cli-v1-.*matrix\.arch.*LLAMA_CPP_REF.*LLAMA_CPP_COMMIT.*hashFiles\('scripts\/build-embed-cli\.sh'\)/,
    );
  });

  it('release builds + verifies the per-arch llama-embedding BEFORE packaging', () => {
    expect(releaseBuild).toMatch(/scripts\/build-embed-cli\.sh/);
    expect(releaseBuild).toMatch(/scripts\/verify-embed-binary\.mjs/);
    expect(releaseBuild).toMatch(/LLAMA_CPP_COMMIT:\s*[0-9a-f]{40}/);
    // electron-builder must bundle the binary, so the build+verify run first.
    const buildIdx = releaseBuild.indexOf('scripts/build-embed-cli.sh');
    const verifyIdx = releaseBuild.indexOf('scripts/verify-embed-binary.mjs');
    const packageIdx = releaseBuild.indexOf('electron-builder --publish never');
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeGreaterThan(buildIdx);
    expect(packageIdx).toBeGreaterThan(verifyIdx);
  });

  it('release stages BOTH mac arches in one packaging job (no per-arch EMBED_ARCH filter)', () => {
    // Unlike CI (which fans out per-arch), electron-builder builds both mac-arch
    // installers in a SINGLE job, so that job must stage both arches together.
    // build-embed-cli.sh with no EMBED_ARCH builds every arch for the OS, so the
    // release build job must NOT pin EMBED_ARCH — otherwise it would drop mac-x64.
    expect(releaseBuild).toMatch(/scripts\/build-embed-cli\.sh/);
    expect(releaseBuild).not.toMatch(/EMBED_ARCH/);
  });

  it('SHA-pins every CI action to a 40-hex commit with a # vX.Y.Z comment', () => {
    // Repo rule: any `uses:` (including the new embed-cli job's) must be a full
    // 40-hex SHA pin with a trailing # vX.Y.Z, enforced across the whole CI
    // workflow so an unpinned action can't slip in alongside the embed additions.
    expect(ciUsesLines.length).toBeGreaterThan(0);
    for (const line of ciUsesLines) {
      expect(line).toMatch(/uses:\s*[^@\s]+@[0-9a-f]{40}\s*#\s*v\d+\.\d+\.\d+/);
    }
  });

  it('builds the embedder NETWORK-FREE — forces LLAMA_OPENSSL=OFF so no TLS/HTTP link (AC-4)', () => {
    // llama.cpp's `common` unconditionally links cpp-httplib, and at the pinned
    // commit cpp-httplib compiles WITH OpenSSL HTTPS support whenever CMake's
    // LLAMA_OPENSSL (default ON) discovers a host OpenSSL — baking _SSL_get_error/
    // _X509_STORE_CTX_get_error/_ERR_* references into httplib.cpp.o and linking
    // libssl/libcrypto. On the arm64 runner that host OpenSSL is arm64-only, so the
    // x86_64 cross-link can't resolve those symbols and the mac-x64 leg fails. The
    // embedder never downloads (it reads a LOCAL `-m` GGUF; Kawsay does its own
    // consent-gated model fetch elsewhere), so we force LLAMA_OPENSSL=OFF: the
    // binary then links ZERO TLS/HTTP/curl code (AC-4 zero-egress) AND the x64 leg
    // links clean. NB: LLAMA_CURL is deprecated/ignored at this pin — LLAMA_OPENSSL
    // is the real control for cpp-httplib's OpenSSL support.
    expect(embedBuildScript).toMatch(/-DLLAMA_OPENSSL=OFF/);
  });

  it('adds the embed-cli engine WITHOUT disturbing the whisper-cli job/step/bundle (additive)', () => {
    // The additive-only contract: the whisper-cli CI job + release build step +
    // extraResource must remain intact alongside the new embed ones.
    expect(ciJobBlock('whisper-cli')).toMatch(/scripts\/build-whisper-cli\.sh/);
    expect(releaseBuild).toMatch(/scripts\/build-whisper-cli\.sh/);
    expect(extra).toMatch(assetPathRegex('resources', 'whisper', '${os}-${arch}'));
  });
});

describe('embedder-model publish workflow pins its Python conversion deps (#233)', () => {
  // #233 (from Sentinel PR #232, 🟡 Dim E): the convert job's "Install Python
  // conversion deps" step installed huggingface_hub and self-upgraded pip UNPINNED.
  // The llama.cpp requirements file it installs is already pinned, but a bare
  // `pip install huggingface_hub` resolves to whatever is latest at run time —
  // non-reproducible AND exposed to a future compromised/regressed release — and the
  // produced model bytes (hence the SHA-256 the descriptor pins) must be reproducible.
  // These assertions pin the exact-version install so the step cannot silently drift
  // back to an unpinned resolve.

  it('installs huggingface_hub at an EXACT version pin (== x.y[.z])', () => {
    // The only huggingface_hub API the convert script uses (snapshot_download) is
    // stable across the 0.x→1.x line, so an exact `==` pin is both safe and byte-
    // reproducible for the one-off, revision-pinned model download.
    expect(publishEmbedModelYml).toMatch(
      /pip install\s+['"]?huggingface_hub==\d+\.\d+(\.\d+)?['"]?/,
    );
  });

  it('pins huggingface_hub to a 0.x version (pinned llama.cpp transformers caps huggingface-hub<1.0)', () => {
    // The convert job installs `transformers` from the IMMUTABLE llama.cpp b9848
    // requirements-convert_hf_to_gguf.txt, and that transformers requires
    // `huggingface-hub>=0.34.0,<1.0`. A 1.x pin therefore fails convert_hf_to_gguf.py at
    // import ("ImportError: huggingface-hub>=0.34.0,<1.0 is required ... found ==1.21.0").
    // Pin the LATEST compatible 0.x — a regression guard for exactly that 1.x-pin bug.
    expect(publishEmbedModelYml).toMatch(
      /pip install\s+['"]?huggingface_hub==0\.\d+(\.\d+)?['"]?/,
    );
    // A 1.x (or any >=1.0) pin breaks the pinned-transformers convert import.
    expect(publishEmbedModelYml).not.toMatch(
      /pip install\s+['"]?huggingface_hub\s*(==|>=)\s*1\./,
    );
  });

  it('never installs huggingface_hub UNPINNED (no bare `pip install huggingface_hub`)', () => {
    // The exact regression #233 removed: a version-less install. Only the `==`-pinned
    // form asserted above is allowed.
    expect(publishEmbedModelYml).not.toMatch(/pip install\s+['"]?huggingface_hub['"]?\s*$/m);
  });

  it('drops the unpinned `pip install --upgrade pip` self-upgrade', () => {
    // setup-python already ships a fine pip for `pip install`; an unpinned self-upgrade
    // pulls a non-reproducible pip at run time. #233 drops it — if ever re-added it must
    // be version-pinned, never a bare `--upgrade`.
    expect(publishEmbedModelYml).not.toMatch(/pip install --upgrade pip\b/);
  });
});
