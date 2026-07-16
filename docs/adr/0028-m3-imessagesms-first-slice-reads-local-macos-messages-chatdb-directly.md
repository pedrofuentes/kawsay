### ADR-0028: M3 iMessage/SMS first slice reads local macOS Messages `chat.db` directly
**Date**: 2026-06-28
**Status**: Accepted
**Tier**: auto-with-audit (local file connector, no new dependency, no new network egress).

**Context**: ROADMAP M3 adds more source connectors behind the existing importer interface. The first iMessage/SMS
slice needs to recognize a user-selected macOS Messages folder and preserve text messages with correct Apple-epoch
dates while keeping Kawsay's fully-local, partial-import-resilient architecture.

**Decision**: Add an isolated `imessage` importer registered ahead of the generic folder importer. `canHandle` accepts
only a directory with `chat.db`, `Attachments/`, and the expected Messages SQLite tables. `import` opens `chat.db`
with `better-sqlite3` in read-only/file-must-exist mode, iterates `message`/`handle`/`chat` rows, bounds emitted DTO
strings, converts Apple-epoch timestamps to UTC, and emits pure `message` catalog records with source provenance.
Attachment materialization/linkage and deeper SMS-vs-iMessage semantics are deferred; the row `service` is preserved
in `sourceMeta` for that follow-up.

**Alternatives considered**:
- Copy `chat.db` into scratch before reading — rejected for this slice because read-only access is simpler and avoids
  another original-retention path; if live-locked databases need special handling later, that can be added explicitly.
- Treat `~/Library/Messages` as a generic folder — rejected because it would miss text rows and shadow the connector.
- Add attachment ingestion now — deferred to keep the first PR mergeable and focused on text/date/provenance.

**Consequences**: AC-25 covers the connector's first vertical slice. Existing import orchestration, catalog writes,
zero-egress guardrails, and AC-15 skip reporting remain unchanged. A later M3 PR must add attachment correlation and
any richer iMessage/SMS service-specific behavior.
