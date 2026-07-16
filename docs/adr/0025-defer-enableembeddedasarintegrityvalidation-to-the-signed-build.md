### ADR-0025: Defer enableEmbeddedAsarIntegrityValidation to the signed build
**Date**: 2026-06-24
**Status**: Accepted (refines ADR-0007; v1 exception to ARCHITECTURE §2.5)
**Tier**: auto-with-audit (adjusts the declared security posture for the *unsigned* v1 build). This ADR is
the audit note.

**Context**
`electron/fuses/fuses.ts` `FUSE_CONFIG` declares `enableEmbeddedAsarIntegrityValidation: true` as the
target packaged-app posture. On macOS this fuse **requires code signing**: the asar-integrity hash lives in
`Info.plist` and is only trusted under a valid signature. On the unsigned v1 build (`mac.identity: null`;
signing is a deferred human-required step — ADR-0007), enabling it makes Chromium refuse to load the
renderer from the asar — the packaged app starts but the window is blank with
`Failed to load URL … app.asar/out/renderer/index.html (ERR_FILE_NOT_FOUND)`. This is the documented
Electron behaviour for unsigned builds.

**Decision**
The unsigned v1 build flips every declared fuse **except** `enableEmbeddedAsarIntegrityValidation`, which is
set `false` in `electron-builder.yml`. `FUSE_CONFIG` keeps `true` as the signed-production target, and the
drift guard in `tests/unit/packaging-config.test.ts` encodes the exception (all other fuses lock-step;
integrity asserted `false` for v1 against the `true` FUSE_CONFIG target). The cofounder re-enables it in
`electron-builder.yml` together with Developer ID signing + notarization (see the release checklist).

**Alternatives considered**
- *Keep it `true` and ship v1* — rejected: produces a blank-window app on every unsigned build (including CI
  smoke builds and any pre-signing testing), verified locally.
- *Change FUSE_CONFIG to `false`* — rejected: FUSE_CONFIG is the declared *signed-production* target;
  flipping it there would lose the intent and the cofounder's re-enable signal. The deviation belongs in the
  v1 build config, documented and test-pinned.
- *Ad-hoc sign the whole app to satisfy integrity* — rejected: `resetAdHocDarwinSignature` only re-signs the
  fuse-modified binary; a meaningful integrity guarantee needs the real Developer ID signature, which is the
  deferred human step anyway.

**Consequences**
- ✅ The unsigned v1 dmg/zip launches and loads the renderer (verified) while keeping all other hardening
  fuses active (no Node escape hatches, asar-only loading, hardened `file://`, encrypted cookies).
- ⚠️ asar tamper-evidence is not active until signing is configured; re-enabling it is a checklist item on
  the human-required first-publish gate.
