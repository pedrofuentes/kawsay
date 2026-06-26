// The single, canonical source-of-truth for the opt-in transcription model the
// app may fetch (ADR-0027 Decision 6 / AC-17, AC-24). EVERYTHING about the one
// permitted, data-free model download is pinned here — the exact URL, its signed
// redirect host, and the hard-coded integrity (SHA-256 + byte size) — so the
// download manager (`model-download.ts`), the integrity check (`model-integrity.ts`),
// and the network-guard allowlist (`security/network-guard.ts`) all agree on the
// same immutable facts and can never drift apart.
//
// This module is intentionally dependency-free (plain constants, no Node/Electron
// imports) so the security guard can import the pinned URL/host without pulling in
// any runtime surface — it stays trivially auditable and unit-testable.

/** The model file's on-disk basename (also the published GitHub Release asset name). */
export const MODEL_FILE_NAME = 'ggml-small.bin';

/**
 * The pinned origin URL the download targets — Kawsay's OWN GitHub Release asset
 * re-hosting the upstream `ggml-small.bin` byte-for-byte (ADR-0027 Decision 6a).
 * This is matched EXACTLY by the network-guard allowlist (no path/host wildcards).
 */
export const MODEL_DOWNLOAD_URL =
  'https://github.com/pedrofuentes/kawsay/releases/download/models-v1/ggml-small.bin';

/**
 * The redirect/CDN host the pinned `github.com` asset 302-redirects to. The asset
 * URL returns `302 → release-assets.githubusercontent.com/…?se=<expiry>&sig=…&jwt=…`
 * — a SIGNED, time-limited URL whose path + query vary per request (and whose
 * signature can expire mid-download), so the allowlist matches this **host** for
 * the CDN leg rather than an exact URL (ADR-0027 Decision 6a/6d). Both legs stay
 * GET + empty-body; integrity is backstopped by the SHA-256 below regardless of
 * which CDN edge served the bytes.
 */
export const MODEL_DOWNLOAD_REDIRECT_HOST = 'release-assets.githubusercontent.com';

/**
 * The hard-coded expected SHA-256 of `ggml-small.bin` (the upstream Hugging Face
 * LFS oid we re-host). The app NEVER runs an unverified model: the downloaded
 * file is hashed and compared to this value before it is installed, and re-hashed
 * before each `whisper-cli` spawn (ADR-0027 Decision 6b / AC-24).
 */
export const MODEL_SHA256 = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b';

/** The exact expected byte size of `ggml-small.bin` (a cheap pre-hash integrity gate). */
export const MODEL_SIZE_BYTES = 487_601_967;
