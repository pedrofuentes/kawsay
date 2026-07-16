### ADR-0013: Revert Takeout email tooling to `mailparser` + an in-module streaming `From `-delimited splitter (supersedes ADR-0009)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (dependency choice for the C4 Takeout importer; this ADR is the audit note and
restores the `mailparser` reference named in MISSION §3 / AGENTS.md §Tech stack; MISSION §9).

**Context**
ADR-0009 substituted the MISSION §3 / AGENTS.md-named **`mailparser`** with **`mbox-parser` + `postal-mime`**
to satisfy AC-11's two requirements: (1) **split** a multi-message Gmail `.mbox`, and (2) do so by
**streaming**, never loading a (potentially multi-GB) mailbox into memory. Implementing card C4 (#11), the
delegated scope is explicit: use **`mailparser`** (the pre-approved §3 dependency) and pair it with an
in-repo streaming splitter — exactly the "equivalent streaming `From `-delimited splitter … hand-rolled
splitter as the documented escape hatch" that ADR-0009 itself sanctioned. `mbox-parser` + `postal-mime`
were never added to the lockfile, so this is a forward choice, not a removal.

**Decision**
Add **only** `mailparser` (+ `@types/mailparser`) — both pre-approved in MISSION §3. The importer's parse
phase is *stream-split → per-message parse → normalize → emit*:
- **Splitter (in-module, streaming):** read the `.mbox` through a new `FsLike.openReadStream` seam and a
  `node:readline` interface, accumulating lines and flushing a message on each `^From ` separator
  (mboxrd), unescaping `>From ` body lines so they are never mistaken for a separator. The whole file is
  never buffered — constant-memory at any size (AC-11). A separate streaming-splitter **dependency** is
  therefore unnecessary.
- **Per-message parse:** `mailparser`'s `simpleParser` on each extracted block. A block that throws, or
  that has no recognizable headers (truncation / binary noise), is a **skip** (`E_PARSE_MSG`, AC-15).
- Email attachments are materialized into the import scratch dir through a second new optional seam,
  `FsLike.writeFile`, so the worker hashes + content-addresses them like any archive original (§4.4).

**Alternatives considered**
- *Keep ADR-0009 (`mbox-parser` + `postal-mime`).* Rejected for this card: it contradicts the delegated
  instruction and MISSION §3, and would add two deps where the streaming split is a few dozen lines of
  `readline` over a seam we already needed for the multi-GB memory bound.
- *Load the whole `.mbox` and split in memory.* Rejected — violates AC-11 and OOMs on multi-GB exports.
- *A dedicated streaming-splitter dependency.* Unnecessary once the read-stream seam exists; fewer deps =
  smaller supply-chain surface. The `From `/`>From ` mboxrd rules are small and unit-tested adversarially.

**Consequences**
- ✅ AC-11 streaming satisfied with **one** pre-approved dep: constant-memory `.mbox` import at any size;
  messages parsed and emitted one-by-one.
- ✅ Restores the MISSION §3 / AGENTS.md `mailparser` reference; **supersedes ADR-0009** (no invariant
  weakened — still local-only, still streaming, still off-thread; email parsing stays isolated with
  `try/catch` and a malformed message is a skip, AC-15).
- ⚠️ The mboxrd split logic is maintained in-repo (`takeout-importer.ts`) rather than delegated to a
  library — covered by streaming/`>From`/truncation unit tests so regressions surface immediately.
- ➕ Two **optional** `FsLike` methods (`openReadStream`, `writeFile`) are added to the DI seam; existing
  importers and their fixtures are untouched (backward-compatible).
