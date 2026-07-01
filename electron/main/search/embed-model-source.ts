// The single, canonical source-of-truth for the opt-in EMBEDDER model the app may
// fetch for M4 smart search (ADR-0029 / milestone M4-1b). It MIRRORS the M2
// transcription descriptor (transcription/model-source.ts): EVERYTHING about the
// one permitted, data-free embedder download is pinned here — the exact URL, its
// signed CDN redirect host, and the hard-coded integrity (SHA-256 + byte size) — so
// the REUSED download manager (transcription/model-download.ts), the REUSED
// integrity check (transcription/model-integrity.ts), and — in the deferred
// pkg-egress slice — the network-guard allowlist all agree on the same immutable
// facts and can never drift apart.
//
// Like its M2 sibling this module is intentionally dependency-free (plain
// constants, no Node/Electron imports) so the security guard can import the pinned
// URL/host WITHOUT pulling in any runtime surface — it stays trivially auditable and
// unit-testable.
//
// The cofounder chose CONSENT-DOWNLOAD (not bundling) for the ~124 MB embedder
// GGUF: it is fetched once, on an explicit smart-search opt-in, into the exact path
// resolveEmbedModelPath (search/embed-cli.ts, seam-1) already checks — at which
// point the embedder becomes AVAILABLE and the merged live search (seam-3) lights
// up. A shipped GGUF MUST have `tokenizer.ggml.model == t5` (SentencePiece); that
// provenance/integrity assertion is a publish/packaging-time guard, hard-asserted by
// scripts/convert-embed-model.sh in publish-embed-model.yml — NOT here.

/**
 * The GGUF basename — MUST equal `EMBED_MODEL_FILENAME` (search/embed-cli.ts), the
 * name `resolveEmbedModelPath` resolves. Duplicated (not imported) to keep this
 * descriptor dependency-free; a unit test asserts the two never drift apart.
 */
export const EMBED_MODEL_FILE_NAME = 'multilingual-e5-small-q4_k_m.gguf';

/**
 * The pinned origin URL the embedder download targets — Kawsay's OWN GitHub Release
 * asset (mirrors the M2 re-hosting model). Matched EXACTLY by the network-guard
 * allowlist (no path/host wildcards) once the pkg-egress slice adds it.
 *
 * The release TAG (`models-embed-v1`) is FINAL: the maintainer-gated
 * `.github/workflows/publish-embed-model.yml` converts the model and uploads the GGUF
 * to this exact tag. {@link EMBED_MODEL_SHA256} and {@link EMBED_MODEL_SIZE_BYTES} stay
 * TODO(post-publish) — they are known only AFTER that workflow runs, then pinned in a
 * tiny follow-up that also allowlists this URL in the network guard. Until both land
 * the guard blocks the fetch, so this URL is NOT yet a live download endpoint.
 */
export const EMBED_MODEL_DOWNLOAD_URL =
  'https://github.com/pedrofuentes/kawsay/releases/download/models-embed-v1/multilingual-e5-small-q4_k_m.gguf';

/**
 * The redirect/CDN host the pinned `github.com` asset 302-redirects to — the SAME
 * signed GitHub release-assets edge the M2 model uses (see the M2 descriptor for
 * why the allowlist matches this HOST, not an exact signed URL whose path/query
 * vary per request). Integrity is backstopped by the SHA-256 below regardless of
 * which CDN edge served the bytes.
 */
export const EMBED_MODEL_DOWNLOAD_REDIRECT_HOST = 'release-assets.githubusercontent.com';

/**
 * The expected SHA-256 of the embedder GGUF. The app NEVER installs an unverified
 * model: the downloaded file is hashed + size-checked before it is renamed into the
 * `resolveEmbedModelPath` location.
 *
 * TODO(post-publish): all-zero sentinel. The real digest is printed by
 * publish-embed-model.yml when it converts + uploads the GGUF; until it is pinned here
 * this deliberately cannot match any real bytes, so an accidental fetch fails closed
 * (verification rejects, nothing is installed).
 */
export const EMBED_MODEL_SHA256 = '0'.repeat(64);

/**
 * The expected byte size of the embedder GGUF (a cheap pre-hash integrity gate).
 *
 * TODO(post-publish): approximate (~124 MiB). The exact byte count is printed by
 * publish-embed-model.yml when it converts + uploads the GGUF, and pinned here in the
 * same follow-up as the SHA-256.
 */
export const EMBED_MODEL_SIZE_BYTES = 130_000_000;
