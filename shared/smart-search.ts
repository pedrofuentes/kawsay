// Process-neutral facts about the opt-in SMART-SEARCH embedder model that the
// renderer (the consent UI) quotes to the user. It mirrors `shared/transcription.ts`
// and lives in `shared/` precisely so the renderer can name the model's size
// without reaching across the main↔renderer boundary into `electron/main`.
//
// Intentionally dependency-free (a plain constant, no Node/Electron imports), so
// the security-critical `electron/main/search/embed-model-source.ts` can re-export
// it without pulling in any runtime surface (mirrors ADR-0027 Decision 6).

/**
 * The DISPLAY byte size the smart-search intro + progress copy derive from —
 * 130,000,000 bytes ≈ 124 MiB, the current embedder descriptor placeholder. It is
 * a user-facing figure only (the intro's "about 124 MB"), NOT the integrity gate:
 * the real download is checksum- and size-verified in the main process against
 * `EMBED_MODEL_SIZE_BYTES`/`EMBED_MODEL_SHA256`.
 *
 * Kept in sync with the published model at go-live: the maintainer's finalize PR
 * sets the true size here AND in `electron/main/search/embed-model-source.ts` when
 * the real embedder is published (the same PR that flips `offered` true).
 */
export const SMART_SEARCH_MODEL_SIZE_BYTES = 130_000_000;
