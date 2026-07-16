### ADR-0014: Hand-rolled RFC 4180 CSV reader for the LinkedIn importer (no `csv-parse`/`papaparse` dependency)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (card C5 pre-authorized adding `csv-parse` as auto-with-audit; this ADR is the
required audit note for choosing instead to add **no** dependency). Adds no network egress, backend, or
external origin, so the local-only invariant (ADR-0008, AC-4) is untouched.

**Context**
Card C5 (#12) adds the LinkedIn importer (AC-16), which must parse LinkedIn's `messages.csv`,
`Connections.csv`, and `Rich_Media.csv`. Real exports are messy: quoted fields with embedded commas and
newlines, doubled `""` escapes, a UTF-8 BOM on the first cell, mixed CR/LF/CRLF terminators, and a free-text
`Notes:` preamble before `Connections.csv`'s header. Splitting naively on commas/newlines would truncate a
message or smear it across rows — the exact "never silently drop a memory" failure the WhatsApp importer was
hardened against. The card pre-authorized adding the tiny, well-known `csv-parse` for this (auto-with-audit),
and `docs/ARCHITECTURE.md` had floated `papaparse` as a candidate.

**Decision**
Add **no** new dependency. Implement a small, dependency-free, single-pass RFC 4180 reader at
`electron/main/importers/csv.ts` (`parseCsv(input): string[][]`) that handles quoted fields, embedded
commas/newlines, doubled-quote escapes, a leading BOM, and CR/LF/CRLF rows. Header interpretation (locating
the real header past a preamble, case/space-insensitive column matching, synonyms) stays in the importer,
not the reader. The reader and the importer's CSV behavior are pinned by unit tests (`tests/unit/csv.test.ts`
plus the LinkedIn importer suite).

**Alternatives considered**
- **`csv-parse`** (pre-authorized): battle-tested and correct, but adds a runtime dependency + transitive
  supply-chain surface to a zero-egress, local-only app for what is ~60 lines of well-understood parsing.
- **`papaparse`** (floated in ARCHITECTURE): heavier and browser/stream-oriented; more surface than this
  main-process path needs.
- **Naive split on `,`/`\n`**: rejected outright — it corrupts quoted commas/newlines and loses data.

**Consequences**
- Zero added dependency, install-time, and supply-chain surface; nothing weakens the AC-4 local-only / no-egress
  invariant. We own the parsing semantics and they are fully unit-tested against adversarial fixtures.
- Trade-off: we maintain the reader ourselves and must keep its edge-case coverage honest (quoted
  commas/newlines, doubled quotes, BOM, CR/LF/CRLF, preamble) — which the committed tests enforce. If a future
  importer needs streaming or dialect-detection beyond RFC 4180, revisit adopting `csv-parse` (this ADR would
  be superseded).
