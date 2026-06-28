import { closeSync, openSync, readSync } from 'node:fs';

// Read the CPU architecture of a native executable straight from its file header
// — no execution, no spawning an emulator, works for a binary built for a
// DIFFERENT arch than the host (the cross-arch case that #175 is about). This is
// the test/guard counterpart that proves a bundled ffmpeg/ffprobe is genuinely
// the arch we shipped it as, the exact check the broken ffprobe-static@3.1.0
// binary (a Mach-O x86_64 mislabelled as darwin/arm64) silently failed.
//
// Supported container formats (Kawsay ships macOS + Windows — ADR-0007):
//   • Mach-O (macOS): thin 64-bit (MH_MAGIC_64) + fat/universal (FAT_MAGIC).
//   • PE/COFF (Windows .exe): the COFF `Machine` field after the PE signature.
//
// The plain-JS sibling `scripts/verify-media-binaries.mjs` carries the same
// reader for the CI build guard (it runs under bare `node`, before any
// transpile); keep the two in lock-step.

/** A CPU arch reported as Node's `process.arch` spelling, or `unknown`. */
export type BinaryArch = 'arm64' | 'x64' | 'ia32' | 'unknown';

// Mach-O constants (CPU_ARCH_ABI64 | base type).
const MH_MAGIC_64 = 0xfeedfacf; // 64-bit thin Mach-O (host-endian); CIGAM = byteswapped.
const FAT_MAGIC = 0xcafebabe; // universal binary (big-endian on disk).
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86 = 0x00000007;

// PE/COFF `Machine` values.
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const IMAGE_FILE_MACHINE_I386 = 0x014c;

function machoCpuToArch(cpuType: number): BinaryArch {
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

function peMachineToArch(machine: number): BinaryArch {
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

/**
 * Detect the CPU arch of the native executable at `file` by reading its header
 * bytes. Returns Node's `process.arch` spelling (`arm64` / `x64` / `ia32`) or
 * `unknown` for an unrecognised container. Never executes the binary.
 */
export function detectBinaryArch(file: string): BinaryArch {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const read = readSync(fd, head, 0, 64, 0);
    if (read < 8) return 'unknown';

    const magicLE = head.readUInt32LE(0);
    const magicBE = head.readUInt32BE(0);

    // Mach-O thin 64-bit: cputype is the second 32-bit word, in the file's endianness.
    if (magicLE === MH_MAGIC_64) return machoCpuToArch(head.readUInt32LE(4));
    if (magicBE === MH_MAGIC_64) return machoCpuToArch(head.readUInt32BE(4));

    // Mach-O fat/universal: big-endian header; first fat_arch.cputype at offset 8.
    if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
      return machoCpuToArch(head.readUInt32BE(8));
    }

    // PE (Windows): DOS 'MZ' → e_lfanew → 'PE\0\0' → COFF Machine (uint16 LE).
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
