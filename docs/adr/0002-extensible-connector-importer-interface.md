### ADR-0002: Extensible connector (importer) interface
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (new internal module boundary — the extensibility contract).

**Context**
v1 ships five sources and the roadmap (M3) keeps adding more. MISSION §3/§4 and AGENTS §Code Style
require **isolated connector modules behind a common importer interface** so new sources are cheap and
the rest of the system stays source-agnostic.

**Decision**
Define one **`Importer`** interface (`electron/main/importers/types.ts`): `canHandle()` +
`import(): AsyncGenerator<CatalogRecord, ImportResult>` over the lifecycle **discover → parse →
normalize → emit**. Importers **emit normalized `CatalogRecord`s** and **do not write the DB** — the
ingestion worker persists them (clean seam). Sources register in a `registry.ts` keyed by `SourceType`.
Dependencies (`fs`, guarded `extractArchive`, `readExif`, `probeMedia`, `hashFile`) are **injected via
`ImporterDeps`** so importers are **unit-testable with fixture fs + fakes** — no real files or
subprocess. Partial failures call `ctx.onSkip(...)` and continue (AC-15); provenance is carried on
every record (`sourceRef`, `author`, `date`, `sourceMeta`) → persisted as `item_occurrences`. The
**parse** phase streams large exports (the Gmail `.mbox` is split message-by-message — ADR-0013).

**Alternatives considered**
- *A bespoke function per source wired ad-hoc into the UI* — rejected; no shared contract, untestable,
  duplicates extraction/metadata logic, and makes new sources expensive.
- *Plugin processes / dynamic loading* — over-engineered for v1's in-repo connectors; a typed registry
  is enough. (Revisit if third-party connectors are ever desired.)
- *Importers write to the DB directly* — rejected; coupling importers to persistence defeats the DI
  testing seam and the "emit records" purity.

**Consequences**
- ✅ Adding a source = implement `Importer` + register + fixtures + one AC; no other layer changes.
- ✅ Importers are unit-testable in isolation against fixtures (AGENTS §Code Style "DI for importers").
- ✅ Uniform provenance + partial-failure handling across all sources.
- ⚠️ Per-source quirks (WhatsApp locale formats, Facebook mojibake, Takeout sidecars) live inside each
  module; the shared contract must stay minimal to avoid leaking source-specifics upward.
