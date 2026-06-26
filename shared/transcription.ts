// Process-neutral facts about the opt-in transcription model that BOTH the main
// process (the download + integrity gate) and the renderer (the consent UI) must
// agree on. It lives in `shared/` precisely so the renderer can quote the model's
// size without reaching across the main↔renderer boundary into `electron/main`.
//
// Intentionally dependency-free (a plain constant, no Node/Electron imports), so
// the security-critical `model-source.ts` can re-export it without pulling in any
// runtime surface (ADR-0027 Decision 6).

/**
 * The exact expected byte size of `ggml-small.bin` — the single source of truth
 * the size copy is derived from. 487,601,967 bytes ≈ 465 MiB, so the intro and the
 * live download progress quote the same "about 465 MB" instead of drifting apart.
 */
export const MODEL_SIZE_BYTES = 487_601_967;
