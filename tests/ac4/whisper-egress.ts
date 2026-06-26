// AC-4 / AC-17(b) OS-deny harness — the verdict logic for a REAL `whisper-cli`
// run under a kernel-enforced network-deny sandbox (ADR-0027 Decision 6/§2,
// PRD AC-17b "Runtime egress assertion"). This is the canonical, unit-tested
// decision layer; the node runner `assert-whisper-no-egress.mjs` — which CI
// executes UNDER the OS-deny sandbox (macOS `sandbox-exec`, Windows program-
// scoped firewall) — mirrors this algorithm, exactly as `positive-controls.ts`
// is mirrored by the `egress-*.mjs` runners (the .ts/.mjs split lets vitest test
// the logic while the runner stays a dependency-free, node-executable script).
//
// The OS sandbox is what guarantees ZERO egress; this module decides whether the
// run actually EXERCISED the binary (exited 0 and produced real speech) so a
// green job can never be a silent no-op — a binary that crashed or transcribed
// nothing proves nothing about egress. TEST-ONLY harness code — never ships.

/** A whisper.cpp `-oj` document was missing, unparseable, or malformed. */
export class WhisperOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WhisperOutputError';
  }
}

/** One `transcription[]` entry as whisper.cpp v1.9.1 emits under `-oj`. */
interface WhisperOjSegment {
  text?: unknown;
}

/** The subset of a whisper.cpp v1.9.1 `-oj` document the harness reads. */
interface WhisperOjDocument {
  transcription?: unknown;
}

/**
 * Parse a whisper.cpp v1.9.1 `-oj` JSON document and return the joined transcript
 * text (segments trimmed, empty/padding segments dropped, joined with single
 * spaces). A valid document with an empty `transcription` array is a legitimate
 * no-speech result and yields `''`. Unparseable JSON or a document with no
 * `transcription` array is a broken run and throws {@link WhisperOutputError} so
 * the harness fails loudly rather than treating garbage as "no egress observed".
 */
export function extractTranscriptText(jsonText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new WhisperOutputError('whisper-cli output was not valid JSON', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WhisperOutputError('whisper-cli output was not a JSON object');
  }
  const { transcription } = parsed as WhisperOjDocument;
  if (!Array.isArray(transcription)) {
    throw new WhisperOutputError('whisper-cli output has no `transcription` array (malformed)');
  }
  return transcription
    .map((segment) => {
      const { text } = (segment ?? {}) as WhisperOjSegment;
      return typeof text === 'string' ? text.trim() : '';
    })
    .filter((text) => text.length > 0)
    .join(' ');
}

/**
 * Normalize transcript text for a forgiving, content-only comparison: lowercase,
 * replace every run of non-alphanumeric characters with a single space, and trim.
 * This makes phrase matching robust to whisper's leading spaces, capitalization,
 * and punctuation (e.g. the trailing comma in "country can do for you,").
 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when `phrase` appears in `text` ignoring case, punctuation, and spacing. */
export function transcriptContainsPhrase(text: string, phrase: string): boolean {
  const needle = normalizeTranscript(phrase);
  if (needle.length === 0) {
    return true;
  }
  return normalizeTranscript(text).includes(needle);
}

/** Inputs for {@link evaluateWhisperRun}. */
export interface WhisperRunInput {
  /** The child's exit code (`null` when it was killed / timed out / never ran). */
  readonly exitCode: number | null;
  /** The transcript extracted from the `-oj` output (see {@link extractTranscriptText}). */
  readonly transcriptText: string;
  /** Optional spoken phrase the transcript must contain (proves real inference ran). */
  readonly expectedPhrase?: string;
}

/** The harness verdict for one real-binary run under the OS-deny sandbox. */
export interface WhisperRunVerdict {
  /** True only when the run proves zero-egress transcription actually happened. */
  readonly ok: boolean;
  /** Whether any speech was produced at all. */
  readonly transcribed: boolean;
  /** A human-readable explanation for the CI log. */
  readonly reason: string;
}

/**
 * Decide whether a `whisper-cli` run UNDER the OS-deny sandbox proves the
 * net-new invariant: the real binary transcribed real audio with all network
 * denied. `ok` is true only when the binary exited 0, produced non-empty speech,
 * and (when given) the speech contains the expected phrase. Anything else — a
 * non-zero/`null` exit, no speech, or a missing phrase — is a `false` verdict so
 * a broken or no-op run can never be mistaken for a passing egress proof.
 */
export function evaluateWhisperRun({
  exitCode,
  transcriptText,
  expectedPhrase,
}: WhisperRunInput): WhisperRunVerdict {
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
