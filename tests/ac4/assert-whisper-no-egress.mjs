// AC-4 / AC-17(b) OS-deny runner — runs the REAL whisper-cli under a kernel
// network-deny and asserts it still transcribes (ADR-0027 Decision 6/§2, PRD
// AC-17b). CI invokes this UNDER the OS deny: on macOS the whole node process is
// wrapped in `sandbox-exec (deny network*)` so the spawned binary inherits the
// kernel deny; on Windows a program-scoped Windows-Firewall outbound-block on
// both node.exe and whisper-cli.exe is already in force. Either way the binary
// gets ZERO network — and because transcription is pure local compute it must
// STILL produce JFK's words. A run that exits 0 with the expected speech proves
// the net-new invariant the in-process spies and the Linux iptables job cannot:
// the real, shipped subprocess does real work with all egress denied.
//
// This runner deliberately MIRRORS the canonical, unit-tested verdict logic in
// `whisper-egress.ts` inline (the same .ts↔.mjs split as positive-controls.ts ↔
// egress-*.mjs), so the script stays dependency-free and node-executable while
// the algorithm is covered by `whisper-egress.test.ts`. It also mirrors the
// app's real argv from transcribe.ts (`-m -f -l -oj -of`) so the harness drives
// the binary exactly as production does. TEST-ONLY harness — never ships.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { argv, cwd, env, exit, platform } from 'node:process';

const WHISPER_CLI_TIMEOUT_MS = Number.parseInt(env.KAWSAY_WHISPER_TIMEOUT_MS ?? '180000', 10);

/** A whisper.cpp `-oj` document was missing, unparseable, or malformed. */
class WhisperOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WhisperOutputError';
  }
}

// ── verdict logic — mirrors whisper-egress.ts (covered by whisper-egress.test.ts) ──

function extractTranscriptText(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new WhisperOutputError(`whisper-cli output was not valid JSON: ${messageOf(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.transcription)) {
    throw new WhisperOutputError('whisper-cli output has no `transcription` array (malformed)');
  }
  return parsed.transcription
    .map((segment) => (typeof segment?.text === 'string' ? segment.text.trim() : ''))
    .filter((text) => text.length > 0)
    .join(' ');
}

function normalizeTranscript(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function transcriptContainsPhrase(text, phrase) {
  const needle = normalizeTranscript(phrase);
  return needle.length === 0 || normalizeTranscript(text).includes(needle);
}

function evaluateWhisperRun({ exitCode, transcriptText, expectedPhrase }) {
  const transcribed = transcriptText.trim().length > 0;
  if (exitCode !== 0) {
    return {
      ok: false,
      transcribed,
      reason: `whisper-cli exited with code ${exitCode === null ? 'null (killed/timed out)' : String(exitCode)}`,
    };
  }
  if (!transcribed) {
    return {
      ok: false,
      transcribed,
      reason: 'whisper-cli produced no transcript — cannot confirm it did real work under deny',
    };
  }
  if (expectedPhrase !== undefined && !transcriptContainsPhrase(transcriptText, expectedPhrase)) {
    return {
      ok: false,
      transcribed,
      reason: `transcript did not contain the expected phrase "${expectedPhrase}"`,
    };
  }
  return {
    ok: true,
    transcribed,
    reason: `transcribed ${String(transcriptText.trim().length)} chars with all network denied`,
  };
}

// ── runner plumbing ─────────────────────────────────────────────────────────

function messageOf(error) {
  return error?.message ?? String(error);
}

/** Minimal `--flag value` parser (positional-free), falling back to env. */
function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

/** Locate the bundled whisper-cli for the current platform/arch (mirrors whisper-cli.ts). */
function defaultCliPath() {
  const osKey = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform;
  const archDir = `${osKey}-${process.arch}`;
  const basename = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return join(cwd(), 'resources', 'whisper', archDir, basename);
}

function fail(message) {
  console.error(`[ac4-whisper] FAIL: ${message}`);
  exit(1);
}

const flags = parseArgs(argv.slice(2));
const cliPath = flags.cli ?? env.KAWSAY_WHISPER_CLI ?? defaultCliPath();
const modelPath = flags.model ?? env.KAWSAY_WHISPER_MODEL;
const wavPath = flags.wav ?? env.KAWSAY_WHISPER_WAV;
const language = flags.lang ?? env.KAWSAY_WHISPER_LANG ?? 'en';
const expectedPhrase = flags.expect ?? env.KAWSAY_WHISPER_EXPECT;

for (const [label, value] of [
  ['whisper-cli', cliPath],
  ['model', modelPath],
  ['wav', wavPath],
]) {
  if (!value) {
    fail(`missing --${label === 'whisper-cli' ? 'cli' : label} (or its KAWSAY_WHISPER_* env)`);
  }
  if (!existsSync(value)) {
    fail(`${label} not found at ${value}`);
  }
}

// Ephemeral, workspace-local output dir (never /tmp; gitignored, cleaned up).
const outDir = mkdtempSync(join(cwd(), '.ac4-whisper-'));
const outputPrefix = join(outDir, 'run');
const outputJson = `${outputPrefix}.json`;

// The EXACT production argv from transcribe.ts buildWhisperArgs — an array argv
// (never a shell string), `-oj` + `-of` so the transcript lands at a known path.
const whisperArgs = ['-m', modelPath, '-f', wavPath, '-l', language, '-oj', '-of', outputPrefix];

console.log(`[ac4-whisper] platform=${platform} arch=${process.arch}`);
console.log(`[ac4-whisper] running REAL whisper-cli with all network denied:`);
console.log(`[ac4-whisper]   ${cliPath} ${whisperArgs.join(' ')}`);

const verdict = await new Promise((resolve) => {
  let stderr = '';
  let settled = false;
  const child = spawn(cliPath, whisperArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({
      ok: false,
      transcribed: false,
      reason: `whisper-cli timed out after ${String(WHISPER_CLI_TIMEOUT_MS)}ms`,
    });
  }, WHISPER_CLI_TIMEOUT_MS);
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.once('error', (error) => {
    finish({
      ok: false,
      transcribed: false,
      reason: `failed to spawn whisper-cli: ${messageOf(error)}`,
    });
  });
  child.once('close', (exitCode) => {
    if (!existsSync(outputJson)) {
      finish({
        ok: false,
        transcribed: false,
        reason: `whisper-cli exited ${String(exitCode)} but wrote no JSON at ${outputJson}\n${stderr}`,
      });
      return;
    }
    try {
      const transcriptText = extractTranscriptText(readFileSync(outputJson, 'utf8'));
      console.log(`[ac4-whisper] transcript: "${transcriptText}"`);
      finish(evaluateWhisperRun({ exitCode, transcriptText, expectedPhrase }));
    } catch (error) {
      finish({ ok: false, transcribed: false, reason: `${messageOf(error)}\n${stderr}` });
    }
  });
});

rmSync(outDir, { recursive: true, force: true });

if (!verdict.ok) {
  fail(verdict.reason);
}
console.log(`[ac4-whisper] PASS: ${verdict.reason}`);
