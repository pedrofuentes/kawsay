### ADR-0016: jsdom + Testing Library (dev-only) to drive the renderer test-first
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. Every addition is a **devDependency** — it ships in no production bundle, opens
no network or external origin, and leaves the local-only runtime (ADR-0008, AC-4) untouched; this ADR is
the required audit note.

**Context**
SENTINEL/AGENTS mandate test-first. Before card U3 the suite was Node-only (importers, IPC, security)
under Vitest; there was no way to render a React component or assert on the DOM, so the onboarding flow
and the shared renderer foundation could not be built test-first. A renderer test environment was needed.

**Decision**
Add dev-only `jsdom` and `@testing-library/{react,jest-dom,user-event}`, and split `vitest.config.ts`
into two projects: the existing **node** project and a new **renderer** project (jsdom environment,
`tests/renderer/setup.ts`). Renderer specs use Testing Library role/label queries and `user-event` —
mirroring how a non-technical user actually operates the UI — and the suite stays a single `pnpm test`.

**Alternatives considered**
- **happy-dom** instead of jsdom: lighter, but jsdom is the most widely-exercised, best-compatible DOM for
  Vitest + Testing Library; chosen for reliability over a marginal speed gain.
- **Playwright component / e2e testing only**: heavier, slower, Electron-oriented here, and unsuitable as a
  fast TDD inner loop. Playwright is still used out-of-band for the visual/screenshot pass.
- **No renderer tests** (manual checking only): violates the test-first mandate; rejected.

**Consequences**
- The renderer is now TDD-able, with renderer specs running in CI through the same `pnpm test` entry point.
- Three small, well-known test-only packages enter the lockfile; none reach production or the network.
- U1/U2 inherit the harness and the `tests/renderer/support` helpers (a fake `window.kawsayAPI`, a render
  wrapper) and write their screens test-first with no further setup.
