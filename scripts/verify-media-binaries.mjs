// CI build guard (#175): assert the staged ffmpeg + ffprobe binaries for THIS
// runner's build leg exist, are non-empty, and are the EXPECTED arch — then fail
// the build if any is missing or wrong-arch, so the bug that shipped v0.2.0 (no
// ffmpeg at all; a Mach-O x86_64 ffprobe mislabelled as darwin/arm64) can never
// silently ship again. Mirrors the whisper-cli "Verify staged binaries" step;
// run under bare `node` after `pnpm stage:media`, before electron-builder.
//
// Self-contained plain ESM (no transpile): it carries its own copy of the Mach-O
// /PE arch reader from tests/helpers/binary-arch.ts — keep the two in lock-step.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MEDIA_TOOLS,
  hostMediaTargets,
  mediaBinaryName,
  stagedBinaryPath,
  targetArch,
} from './stage-media-binaries.mjs';

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
function detectBinaryArch(file) {
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

// --- Guard ----------------------------------------------------------------------

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = hostMediaTargets();
const failures = [];

for (const target of targets) {
  const expectedArch = targetArch(target);
  for (const tool of MEDIA_TOOLS) {
    const path = stagedBinaryPath(tool, target, projectRoot);
    const label = `${target}/${mediaBinaryName(tool, target)}`;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      failures.push(`MISSING ${label} (${path}) — run \`pnpm stage:media\``);
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
    console.log(`ok: ${label} — ${arch}, ${size} bytes`);
  }
}

if (failures.length > 0) {
  console.error(`\nmedia-binary guard FAILED for ${process.platform} (${targets.join(', ')}):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(`\nmedia-binary guard PASSED: ${targets.length * MEDIA_TOOLS.length} binaries verified for ${targets.join(', ')}`);
