# Architecture Decision Records — Kawsay

> **Record every significant technical decision here.** When choosing between approaches,
> document what was chosen and why. This prevents future agents and developers from
> re-debating settled decisions or accidentally reversing them.
>
> Do NOT write decisions to AGENTS.md — they belong here.

## Format

```markdown
### ADR-NNN: Decision Title
**Date**: YYYY-MM-DD
**Status**: Proposed / Accepted / Superseded by ADR-NNN
**Context**: What problem or question prompted this decision?
**Decision**: What was decided?
**Alternatives considered**: What other options were evaluated?
**Consequences**: What are the trade-offs? What does this enable or prevent?
```

> **Authorization tiers** (MISSION §9) are noted on each ADR: `auto` (reversible) · `auto-with-audit`
> (this ADR is the audit note) · `human-required` (blocks until @pedrofuentes approves). The full
> *how* for each decision lives in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Decisions

> ✨ **As of v0.5.0, ADRs have been reorganized into individual files in [`docs/adr/`](./docs/adr/) for better discoverability and maintainability.** See [`docs/adr/README.md`](./docs/adr/README.md) for the complete index and to read each decision.

The format and authorization tiers below remain the reference, and the full set of ADR documents (ADR-0001 through ADR-0030) now live in the per-file structure.

---

## Legacy

All 28 ADRs (ADR-0001 through ADR-0030, with ADR-0018 and ADR-0019 reserved) are now documented in [`docs/adr/`](./docs/adr/). This file previously contained the complete text of each decision; that content has been migrated to per-file ADRs for better navigation and maintenance.

To reference an ADR in code or docs, use the ID (e.g., `ADR-0008`) — links will resolve via the index in [`docs/adr/README.md`](./docs/adr/README.md).
