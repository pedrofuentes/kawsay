### ADR-0005: Electron security hardening + minimal contextBridge IPC surface
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto (reversible config) — but the **zero-egress** portions may never be weakened (NEVER list).

**Context**
Electron apps that load untrusted-derived content need strict hardening. Kawsay also must expose
*some* capability to its renderer (import, browse, search, play media) without giving the renderer
ambient Node/fs/network authority. (MISSION §5/§7; AC-4.)

**Decision**
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (+ worker/subframe variants),
`webSecurity: true`. Block navigation (`will-navigate`) and `window.open` (`setWindowOpenHandler:
deny`). **Strict CSP** (`default-src 'none'; script-src 'self'; connect-src 'none'; img-src 'self'
kawsay-media: data: blob:; media-src 'self' kawsay-media: blob:; font-src 'self';
style-src 'self'; style-src-attr 'unsafe-inline'; …`). The renderer's **entire** capability is a
**minimal, enumerated `contextBridge` IPC surface** — one method per channel (no catch-all `send`),
each payload **zod-validated in preload AND re-validated in main**, with sender-origin checks. Local
media is served via a path-validated **`kawsay-media://`** custom protocol (no `file://` to the
renderer). Package-time: `@electron/fuses` + ASAR integrity (see ADR-0007).

**Alternatives considered**
- *Expose a generic `ipcRenderer.send`/`invoke` passthrough* — rejected; it is a catch-all that defeats
  the validated-surface model and widens attack surface.
- *Serve media as `file://` or marshal bytes over IPC* — rejected; `file://` over-grants the renderer
  and large media (video) marshaled over IPC is slow. A streaming custom protocol is safer and faster.
- *`style-src 'unsafe-inline'` (blanket)* — rejected in favor of the narrower `style-src-attr
  'unsafe-inline'` (needed only for the virtualizer's inline style attributes); stylesheets stay locked
  to `'self'`.

**Consequences**
- ✅ A sandboxed renderer with a tiny, typed, validated capability surface; supports the AC-4 guarantee.
- ✅ Media plays/streams locally with no `file://` exposure and no network.
- ⚠️ Every new renderer capability requires a new, explicitly-validated IPC channel — intentional
  friction that keeps the surface auditable.
