import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FUSE_CONFIG } from '../../electron/fuses/fuses';
import {
  SUPPORTED_WHISPER_TARGETS,
  WHISPER_CLI_RESOURCE_SUBDIR,
} from '../../electron/main/transcription/whisper-cli';

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
};

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

  it('unpacks the native catalog engine and media binaries from the asar', () => {
    // A compiled `.node` cannot be dlopen'd, and ffmpeg/ffprobe cannot be spawned,
    // from inside an asar — they must live in app.asar.unpacked (ADR-0007).
    const unpack = topLevelBlock('asarUnpack');
    expect(unpack).toMatch(/node_modules\/better-sqlite3\//);
    expect(unpack).toMatch(/node_modules\/ffmpeg-static\//);
    expect(unpack).toMatch(/node_modules\/ffprobe-static\//);
  });

  it('rebuilds native modules against the Electron ABI from source', () => {
    expect(builderYml).toMatch(/^npmRebuild:\s*true\s*$/m);
    expect(builderYml).toMatch(/^buildDependenciesFromSource:\s*true\s*$/m);
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
    expect(extra).toMatch(/from:\s*'?resources\/whisper\/\$\{os\}-\$\{arch\}/);
    expect(extra).toMatch(/to:\s*'?whisper\/\$\{os\}-\$\{arch\}/);
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
    expect(extra).toMatch(new RegExp(`to:\\s*'?${WHISPER_CLI_RESOURCE_SUBDIR}/`));
  });

  it('ships NO model alongside the binary (the ggml model is a separate opt-in download)', () => {
    // ADR-0027 Decision 6: only the BINARY is bundled here; the ~466 MiB `small`
    // ggml model is fetched on opt-in (cards #130/#131), never in the installer.
    expect(extra).not.toMatch(/ggml|\.bin\b|model/i);
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
