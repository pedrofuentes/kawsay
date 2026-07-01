// CI build guard (M4-1b · ADR-0029): assert the staged `llama-embedding` binary
// for THIS runner's build leg exists, is non-empty, is the EXPECTED arch, and is
// executable — then fail the build if any check fails, so a missing or wrong-arch
// embed engine can never silently ship (the exact class of bug that shipped v0.2.0
// with no ffmpeg / a wrong-arch ffprobe). It is the embed sibling of
// scripts/verify-media-binaries.mjs and the whisper "Verify staged binaries" step;
// run under bare `node` after scripts/build-embed-cli.sh, before electron-builder.
//
// llama.cpp's `llama-embedding` (MIT) carries no nonfree/licence concern (unlike
// the ffmpeg guard), so this asserts existence + arch + executability only.
//
// Self-contained plain ESM (no transpile): it carries its own copy of the Mach-O
// /PE arch reader from tests/helpers/binary-arch.ts (and scripts/verify-media-
// binaries.mjs) — keep the three in lock-step.

import { accessSync, closeSync, constants, openSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --- shipped matrix (lock-step with SUPPORTED_EMBED_TARGETS in embed-cli.ts) -----

/** The exact `<os>-<arch>` targets Kawsay ships `llama-embedding` for (ADR-0007). */
export const EMBED_TARGETS = ['mac-arm64', 'mac-x64', 'win-x64'];

/** The platform-independent stem of the executable (`.exe` is added on Windows). */
export const EMBED_CLI_BINARY_BASENAME = 'llama-embedding';

/** Sub-directory (under `resources/`) that holds the per-arch embed binaries. */
export const EMBED_RESOURCE_SUBDIR = 'embed';

/** The CPU arch a `<os>-<arch>` target ships for, in Node's `process.arch` spelling. */
export function targetArch(target) {
  return target.endsWith('-arm64') ? 'arm64' : 'x64';
}

/** The Node `process.platform` a `<os>-<arch>` target ships for. */
export function targetPlatform(target) {
  return target.startsWith('mac-') ? 'darwin' : 'win32';
}

/** The platform-specific executable name (`llama-embedding.exe` on Windows). */
export function embedBinaryName(target) {
  return targetPlatform(target) === 'win32'
    ? `${EMBED_CLI_BINARY_BASENAME}.exe`
    : EMBED_CLI_BINARY_BASENAME;
}

/** Where a target's binary is staged under a project/app root. */
export function stagedEmbedBinaryPath(target, projectRoot) {
  return join(projectRoot, 'resources', EMBED_RESOURCE_SUBDIR, target, embedBinaryName(target));
}

/**
 * The `<os>-<arch>` targets to verify on this host's build leg. With `EMBED_ARCH`
 * set (CI's per-arch matrix legs), verify ONLY that single `<os>-<arch>`; unset
 * (release packaging builds every arch in one job, and local dev-builds), verify
 * every arch this OS ships — macOS arm64 + x64, Windows x64. Kept in lock-step with
 * build-embed-cli.sh's EMBED_ARCH selector so the guard checks exactly what the
 * build produced. Throws on any other platform (Kawsay ships macOS + Windows only
 * — ADR-0007) or an arch this OS does not ship.
 */
export function hostEmbedTargets(platform = process.platform, arch = process.env.EMBED_ARCH) {
  let all;
  switch (platform) {
    case 'darwin':
      all = ['mac-arm64', 'mac-x64'];
      break;
    case 'win32':
      all = ['win-x64'];
      break;
    default:
      throw new Error(
        `cannot verify llama-embedding on ${platform} (Kawsay ships macOS + Windows only)`,
      );
  }
  if (arch) {
    const target = `${platform === 'darwin' ? 'mac' : 'win'}-${arch}`;
    if (!all.includes(target)) {
      throw new Error(
        `EMBED_ARCH='${arch}' is not a valid arch for ${platform} (have: ${all.join(', ')})`,
      );
    }
    return [target];
  }
  return all;
}

// --- Mach-O / PE arch reader (lock-step copy of tests/helpers/binary-arch.ts) ---

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86 = 0x00000007;

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const IMAGE_FILE_MACHINE_I386 = 0x014c;

function machoCpuToArch(cpuType) {
  switch (cpuType) {
    case CPU_TYPE_ARM64:
      return 'arm64';
    case CPU_TYPE_X86_64:
      return 'x64';
    case CPU_TYPE_X86:
      return 'ia32';
    default:
      return 'unknown';
  }
}

function peMachineToArch(machine) {
  switch (machine) {
    case IMAGE_FILE_MACHINE_AMD64:
      return 'x64';
    case IMAGE_FILE_MACHINE_ARM64:
      return 'arm64';
    case IMAGE_FILE_MACHINE_I386:
      return 'ia32';
    default:
      return 'unknown';
  }
}

/** Detect the CPU arch of the native executable at `file` from its header bytes. */
export function detectBinaryArch(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const read = readSync(fd, head, 0, 64, 0);
    if (read < 8) return 'unknown';

    const magicLE = head.readUInt32LE(0);
    const magicBE = head.readUInt32BE(0);

    if (magicLE === MH_MAGIC_64) return machoCpuToArch(head.readUInt32LE(4));
    if (magicBE === MH_MAGIC_64) return machoCpuToArch(head.readUInt32BE(4));

    if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
      return machoCpuToArch(head.readUInt32BE(8));
    }

    if (head[0] === 0x4d && head[1] === 0x5a) {
      const peOffset = head.readUInt32LE(0x3c);
      const peHeader = Buffer.alloc(6);
      readSync(fd, peHeader, 0, 6, peOffset);
      if (peHeader.toString('ascii', 0, 4) === 'PE\0\0') {
        return peMachineToArch(peHeader.readUInt16LE(4));
      }
    }

    return 'unknown';
  } finally {
    closeSync(fd);
  }
}

/** True if `path` carries a POSIX execute bit for the current user. */
function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// --- Guard ----------------------------------------------------------------------

export function verifyEmbedBinaries({
  projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  targets = hostEmbedTargets(),
  log = console.log,
} = {}) {
  const failures = [];

  for (const target of targets) {
    const expectedArch = targetArch(target);
    const path = stagedEmbedBinaryPath(target, projectRoot);
    const label = `${target}/${embedBinaryName(target)}`;

    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      failures.push(`MISSING ${label} (${path}) — run \`./scripts/build-embed-cli.sh\``);
      continue;
    }
    if (size === 0) {
      failures.push(`EMPTY ${label} (${path})`);
      continue;
    }
    const arch = detectBinaryArch(path);
    if (arch !== expectedArch) {
      failures.push(`WRONG-ARCH ${label}: expected ${expectedArch}, got ${arch} (${path})`);
      continue;
    }
    // Windows marks executability by extension, not a POSIX bit, so only the
    // non-Windows targets are required to carry an execute bit (build-embed-cli.sh
    // chmod +x's them; copyFileSync elsewhere drops the source mode).
    if (targetPlatform(target) !== 'win32' && !isExecutable(path)) {
      failures.push(`NOT-EXECUTABLE ${label} (${path}) — missing an execute bit`);
      continue;
    }
    log(`ok: ${label} — ${arch}, ${size} bytes`);
  }

  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = hostEmbedTargets();
  const failures = verifyEmbedBinaries({ targets });

  if (failures.length > 0) {
    console.error(`\nembed-binary guard FAILED for ${process.platform} (${targets.join(', ')}):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }

  console.log(
    `\nembed-binary guard PASSED: ${targets.length} binaries verified for ${targets.join(', ')}`,
  );
}
