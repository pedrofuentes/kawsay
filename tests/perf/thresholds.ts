// AC-21 (accuracy) + AC-18 (performance) thresholds for the M2 offline harness.
//
// LOCKED EMPIRICALLY from the measurement recorded in
// docs/perf/m2-wer-rtf-results.md (ADR-0027): the bundled `whisper-cli` (v1.9.1) +
// `small` model over the 8 labeled clips, invoked exactly as the app does
// (auto-detect language). Measured on Apple Silicon (darwin/arm64, Metal):
//
//   • Spanish aggregate WER ....... 15.2%        (→ ceiling 22%)
//   • overall aggregate WER ....... 13.6%        (→ ceiling 18%)
//   • language auto-detect ........ 7/8 = 87.5%  (→ floor 75%)
//   • mean RTF .................... 0.25×         (≈4× faster than real time)
//
// whisper.cpp greedy decoding is deterministic, so WER is stable run-to-run; the
// ceilings sit just above the measured numbers (with a little cross-platform
// float head-room) so the gated test is a real regression guard. RTF varies by
// host/backend (Metal ≪ a Windows CPU), so its ceiling is a deliberately loose
// cross-platform sanity bound — the concrete per-platform RTF target lives in the
// results doc, not here.
//
// ⚠️ These are calibrated on CLEAN, well-articulated single sentences. Real
// Kawsay audio — noisy, accented, emotional WhatsApp voice notes — is materially
// worse; AC-21's FIELD ceiling must be re-derived on real Spanish samples (see
// the caveat in the results doc). The Spanish ceiling is intentionally NOT near
// the ~0% the correctly-detected clips hit, because one short clip auto-detected
// as Italian — a real, reproducible LID failure on very short utterances.

/** The locked WER (AC-21) + RTF (AC-18) ceilings the gated harness asserts. */
export interface PerfThresholds {
  /** AC-21 — max aggregate (corpus) WER on the Spanish clips (Kawsay's primary audience). */
  readonly werCeilingEs: number;
  /** AC-21 — max aggregate WER across ALL languages (es + de + ru). */
  readonly werCeilingOverall: number;
  /** AC-21 — min language auto-detection accuracy over transcribed clips. */
  readonly detectionAccuracyFloor: number;
  /** AC-18 — loose cross-platform max mean RTF (processing ÷ audio); a sanity bound. */
  readonly rtfCeiling: number;
}

export const PERF_THRESHOLDS: PerfThresholds = {
  werCeilingEs: 0.22,
  werCeilingOverall: 0.18,
  detectionAccuracyFloor: 0.75,
  rtfCeiling: 3,
};
