### ADR-0009: Takeout `.mbox` streaming split + email-parser substitution (`mailparser` → `mbox-parser` + `postal-mime`)
**Date**: 2026-06-23
**Status**: Superseded by ADR-0013
**Tier**: auto-with-audit (dependency substitution + new internal parse tooling — this ADR is the audit
note for the `mailparser` reference in MISSION §3 / AGENTS.md §Tech stack; MISSION §9).

**Context**
MISSION §3 / AGENTS.md name **`mailparser`** for "Takeout / email". Two problems surfaced in red-team:
(1) **`mailparser` and `postal-mime` parse a *single* RFC-822 message** — neither can *split or stream*
a multi-message Gmail **`.mbox`**, which in a real Takeout can be **multiple GB**; (2) **AC-11 requires
streaming** parses that **do not load the whole `.mbox` into memory**. A single-message parser alone
therefore cannot satisfy AC-11, regardless of which one we pick.

**Decision**
Split the `.mbox` with a **streaming splitter** — **`mbox-parser`** (async-paginated; reads
message-by-message without buffering the file; an equivalent streaming `From `-delimited splitter is an
acceptable substitute) — and parse **each** extracted message with **`postal-mime`** (modern, zero-dep,
ESM, actively maintained) **instead of `mailparser`**. The importer's parse phase becomes
*stream-split → per-message parse → normalize → emit* (ARCHITECTURE §3.2/§5). Both are **non-heavy**
deps. This ADR is the required **auto-with-audit** note for substituting `mailparser`; the substitution
changes only *which* email tooling is used — it **weakens no invariant** (still local-only, still
streaming, still off-thread).

**Alternatives considered**
- *Keep `mailparser`.* It is older, heavier (callback/stream API), and **still single-message** — a
  splitter would be required anyway. `postal-mime` chosen for ESM + active maintenance + smaller surface.
- *Load the whole `.mbox` and split in memory.* **Rejected** — violates AC-11 streaming and OOMs on
  multi-GB exports.
- *Hand-roll a `From `-line splitter.* Viable as a fallback, but easy to get subtly wrong (quoting,
  `>From` escaping); a maintained streaming splitter is preferred, with a hand-rolled splitter as the
  documented escape hatch if the dep is ever unsuitable.

**Consequences**
- ✅ AC-11 streaming satisfied: constant-memory `.mbox` import at any size; messages fed one-by-one to
  the per-message parser and emitted as found (first-memory payoff, SM-2).
- ✅ The MISSION §3 / AGENTS.md `mailparser` reference is **superseded for v1** by `mbox-parser` +
  `postal-mime`, audited here (auto-with-audit; the §3 stack list is illustrative — "e.g." tooling).
- ⚠️ Two small deps instead of one; both pinned and Dependabot-tracked. Email parsing remains isolated
  in the worker with `try/catch` + per-message caps (a malformed message is a **skip**, AC-15).
