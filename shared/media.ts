// The single source of truth for the custom, LOCAL-ONLY media scheme (#428). Both
// the main-process protocol handler (which resolves an opaque id → a confined
// originals-store file) and the renderer (which names a memory by id to play it)
// import from here, so the URL shape can never drift between the two sides.
//
// The scheme is already allowlisted as strictly-local by the runtime network guard
// (`electron/main/security/network-guard.ts` LOCAL_SCHEMES) and admitted narrowly
// by the CSP (`media-src`/`img-src kawsay-media:`); nothing about it is networked
// (AC-4). A URL carries EXACTLY one opaque catalog id — never a filesystem path.

/** The custom scheme media bytes are served over — local, in-process, never dialled. */
export const MEDIA_PROTOCOL_SCHEME = 'kawsay-media';

/** The fixed authority of every media URL; the opaque id lives in the single path segment. */
export const MEDIA_URL_HOST = 'item';

/**
 * Build the `kawsay-media://item/<id>` URL for one memory. `id` is the opaque
 * catalog uuid; the main-process handler re-validates it with `z.uuid()` and
 * resolves it to a CONFINED originals-store path server-side, so the renderer never
 * names — and can never name — a filesystem path.
 */
export function mediaUrl(id: string): string {
  return `${MEDIA_PROTOCOL_SCHEME}://${MEDIA_URL_HOST}/${id}`;
}
