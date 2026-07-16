### ADR-0011: `nock` as the http(s) layer of the AC-4 zero-egress test harness
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (test-only tooling — MISSION §9 lists test dependencies as `auto`; this ADR is
the required audit note for the addition). **`nock` is a `devDependency` only** — it never ships in the
packaged app and adds no runtime/network capability to the product.

**Context**
Card X1 (#16) builds the AC-4 harness (ARCHITECTURE §6.2; ADR-0008 §5). The Node-side defense-in-depth
spies must assert **zero** outbound `http`/`https` requests during a representative flow. Prototype
patching (`net.Socket.prototype.connect`, `dgram.Socket.prototype.send`) reliably intercepts raw
TCP/UDP/TLS/HTTP2 regardless of ESM/CJS import style, but the canonical, well-understood way to deny and
record the **http(s) client layer** is `nock.disableNetConnect()` — exactly the tool PRD AC-4 and
ARCHITECTURE §6.2 name ("`nock.disableNetConnect()` for `http(s)`").

**Decision**
Add **`nock@^14`** as a **devDependency**. It is used only under `tests/ac4/` to (a) deny all net
connect at the http layer during the in-process spy run and (b) prove the harness is not a silent no-op
via a positive control (a deliberate `http`/`https` request that `nock` must block). No other dependency
is added by this card.

**Alternatives considered**
- *Hand-roll an `http`/`https` agent stub.* Rejected — reinvents `nock`, less battle-tested, and the
  acceptance criterion explicitly names `nock`.
- *Rely solely on the socket prototype patch for http(s).* Rejected as the primary http assertion —
  the prototype patch is kept as defense-in-depth, but `nock` is the documented, legible http-layer
  control and makes the positive control unambiguous.

**Consequences**
- ✅ The http(s) layer of AC-4 is asserted with the tool the spec names; positive control is legible.
- ✅ Zero production impact — `devDependency`, used only in `tests/ac4/`.
- ⚠️ One more dev dependency to keep patched (Dependabot covers it).
