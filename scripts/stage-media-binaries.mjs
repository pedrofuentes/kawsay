// Stage the correct-arch ffmpeg + ffprobe binaries for each shipped build leg
// into resources/media/<os>-<arch>/, mirroring how scripts/build-whisper-cli.sh
// stages whisper-cli (#175). electron-builder then copies the per-arch directory
// as an extraResource (electron-builder.yml), and the app resolves it at runtime
// through electron/main/importers/deps/media-binaries.ts.
//
// Source binaries come from the @ffmpeg-installer / @ffprobe-installer
// per-platform packages, which ship prebuilt binaries as plain files (NO
// download-on-install — that is the trap that left v0.2.0 with no ffmpeg). pnpm
// `supportedArchitectures` (package.json) installs all three target packages on
// every runner, so a single arm64 macOS runner can stage the x64 dmg's binaries
// too — closing the cross-arch gap.
//
// Plain ESM run under bare `node` (predev / predist / CI before packaging); its
// exports are also exercised by tests/unit/media-binaries.test.ts (typed via the
// sibling stage-media-binaries.d.mts). Keep the two in lock-step.

import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** The media tools Kawsay bundles and spawns. */
export const MEDIA_TOOLS = ['ffmpeg', 'ffprobe'];

/**
 * The exact `<os>-<arch>` targets Kawsay ships ffmpeg + ffprobe for — identical
 * to whisper-cli's matrix (macOS arm64 + x64, Windows x64). Windows arm64 is
 * deferred (ADR-0007).
 */
export const SUPPORTED_MEDIA_TARGETS = ['mac-arm64', 'mac-x64', 'win-x64'];

/** The CPU arch a `<os>-<arch>` target ships for, in Node's `process.arch` spelling. */
export function targetArch(target) {
  return target.endsWith('-arm64') ? 'arm64' : 'x64';
}

/** The Node `process.platform` a `<os>-<arch>` target ships for. */
export function targetPlatform(target) {
  return target.startsWith('mac-') ? 'darwin' : 'win32';
}

/** The platform-specific executable name (`ffmpeg.exe` / `ffprobe.exe` on Windows). */
export function mediaBinaryName(tool, target) {
  return targetPlatform(target) === 'win32' ? `${tool}.exe` : tool;
}

const INSTALLER_SCOPE = { ffmpeg: '@ffmpeg-installer', ffprobe: '@ffprobe-installer' };

/**
 * Absolute path of the installer-provided source binary for a tool/target. The
 * installer's main package (e.g. `@ffmpeg-installer/ffmpeg`) sits beside the
 * per-platform packages (`@ffmpeg-installer/darwin-x64`, `win32-x64`, …) that
 * actually carry the binaries; resolve the scope dir from the main package, then
 * the `<platform>-<arch>` sibling. No version is hard-coded.
 */
export function sourceBinaryPath(tool, target) {
  const scope = INSTALLER_SCOPE[tool];
  if (scope === undefined) throw new Error(`unknown media tool: ${tool}`);
  const mainPkgJson = require.resolve(`${scope}/${tool}/package.json`);
  const scopeDir = dirname(dirname(mainPkgJson));
  return join(scopeDir, `${targetPlatform(target)}-${targetArch(target)}`, mediaBinaryName(tool, target));
}

/** Where a tool/target binary is staged under a project/app root. */
export function stagedBinaryPath(tool, target, projectRoot) {
  return join(projectRoot, 'resources', 'media', target, mediaBinaryName(tool, target));
}

/**
 * The `<os>-<arch>` targets to stage on this host's electron-builder leg: macOS
 * builds BOTH arm64 + x64 dmgs on one runner, Windows builds x64. Throws on any
 * other platform (Kawsay ships macOS + Windows only — ADR-0007).
 */
export function hostMediaTargets(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return ['mac-arm64', 'mac-x64'];
    case 'win32':
      return ['win-x64'];
    default:
      throw new Error(`cannot stage media binaries on ${platform} (Kawsay ships macOS + Windows only)`);
  }
}

/**
 * Copy the correct-arch ffmpeg + ffprobe for each target into
 * `<projectRoot>/resources/media/<target>/`, making them executable. copyFileSync
 * does NOT preserve the source mode, so chmod +x is required for every non-Windows
 * target (the installer ffprobe also ships without +x). Returns the staged paths.
 */
export function stageMediaBinaries({ targets = hostMediaTargets(), projectRoot } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('stageMediaBinaries requires a non-empty projectRoot');
  }
  const staged = [];
  for (const target of targets) {
    for (const tool of MEDIA_TOOLS) {
      const src = sourceBinaryPath(tool, target);
      const { size } = statSync(src); // throws if the per-arch installer package is absent
      if (size === 0) throw new Error(`source ${tool} for ${target} is empty: ${src}`);
      const dest = stagedBinaryPath(tool, target, projectRoot);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      if (targetPlatform(target) !== 'win32') chmodSync(dest, 0o755);
      staged.push(dest);
    }
  }
  return staged;
}

// CLI: stage this host's build-leg targets into the repo's resources/ tree.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const targets = hostMediaTargets();
  const staged = stageMediaBinaries({ targets, projectRoot });
  for (const p of staged) console.log(`staged ${p}`);
  console.log(`staged ${staged.length} media binaries for ${targets.join(', ')}`);
}
