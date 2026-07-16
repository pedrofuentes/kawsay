### ADR-0021: `@vitest/coverage-v8` (dev-only) wires the ≥80% coverage gate the DoD already required
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. The addition is a single **devDependency** — it ships in no production bundle,
opens no network or external origin, and leaves the local-only runtime (ADR-0008, AC-4) untouched; this
ADR is the required audit note.

**Context**
AGENTS.md (§Ratchet) and `docs/SENTINEL.md` (§Coverage, check 6) have always specified a **≥80%** coverage
bar as part of the Definition of Done, and `docs/TESTING-STRATEGY.md` documents `pnpm test --coverage` — but
no coverage **provider** was ever installed, so that command errored and the threshold was unenforceable
(SENTINEL treats an unset threshold as N/A, "do not invent"). Card #109 wires the measurement up so the bar
is real, reported, and regression-protected, with no other behaviour change.

**Decision**
Add the dev-only **`@vitest/coverage-v8`** (`^3.2.6`, pinned to the installed Vitest 3 major so the provider
and runner never skew) and a `coverage` block in `vitest.config.ts`: provider `v8`, reporters
`['text','html','json-summary']` (console table for humans, HTML for drill-down, `coverage-summary.json` for
a future CI/Sentinel parse), `include` scoped to the three shipped source roots (`electron/`, `shared/`,
`src/`), and `thresholds` of **80** on statements/branches/functions/lines. A `pnpm coverage` script runs it.
The only exclusions beyond the v8 defaults and ambient `**/*.d.ts` declarations are the four **process
entry/bootstrap glue** files that import Electron/DOM globals and wire singletons at module load, so they
cannot execute under vitest/jsdom: `electron/main/index.ts` (main entry), `electron/preload/index.ts`
(preload `contextBridge` bootstrap), `electron/main/importers/workers/ingestion-worker.ts` (`worker_threads`
entry), and `src/main.tsx` (React `createRoot` bootstrap). Every collaborator those four compose is
unit-tested in isolation. The generated `coverage/` report is git-, prettier-, and eslint-ignored.

Measured baseline across the existing 525-test suite (no gap-filling tests were needed): **statements 94.64%,
branches 84.35%, functions 95.57%, lines 94.64%** — already over 80 on every metric — so the threshold pins
the *existing* posture rather than chasing it.

**Alternatives considered**
- **`@vitest/coverage-istanbul`**: the other first-party provider, but it instruments source via Babel (slower,
  an extra transform on top of our esbuild pipeline) and reports the transpiled, not authored, shape less
  faithfully. `v8` is Vitest's default, uses the engine's native coverage with no instrumentation step, and is
  the lower-friction fit for an esbuild/jsx-automatic two-project setup. Istanbul's finer per-statement
  accounting buys nothing at this bar.
- **Standalone `c8` / `nyc`**: redundant — Vitest's `v8` provider *is* c8 under the hood, already integrated
  with the runner and the `node` + `renderer` projects, so a separate tool would only duplicate config.
- **Ratcheting the thresholds up to the achieved ~94/84/95/94**: rejected. The DoD contract is **80**; pinning
  at the achieved number makes unrelated future PRs brittle (a legitimate refactor that drops a few covered
  lines would red-line the gate). 80 is the hard floor; the AGENTS.md ratchet separately guards the achieved
  baseline against regression. The branch floor is held at 80 (achieved 84.35%) deliberately — branches is the
  metric most sensitive to defensive `if`/`??` paths, so a notch of headroom avoids flapping.
- **Excluding the type-only contracts (`types.ts`, `protocol.ts`, `shared/kawsay-api.ts`) or the worker
  composition root (`ingestion-context.ts`) to inflate the number**: rejected as coverage-gaming. They stay
  *in* the measurement; the suite clears 80 with them included, which keeps the number honest and conservative.
- **Adding the CI `coverage` gate in the same PR**: deferred. A `.github/workflows` change is harness-integrity
  (coordinator/cofounder-gated). This PR ships only the local tooling and proposes the CI step for later.

**Consequences**
- `pnpm coverage` now produces a text table, a browsable `coverage/` HTML report, and `coverage-summary.json`;
  the run **fails** if any of the four metrics drops below 80, turning the long-documented bar into an enforced
  gate that runs when `pnpm coverage` is invoked; the normal `pnpm test` inner loop remains the fast non-coverage Vitest run.
- Only true bootstrap glue is excluded; all testable logic (importers, catalog repo, ingest, IPC validation,
  hooks, security helpers, the worker job driver) remains measured, so the number reflects real behaviour.
- One small, well-known, dev-only package enters the lockfile; it never reaches production or the network,
  consistent with the dev-tooling tier of ADR-0020 (`axe-core`) and ADR-0017.
- A follow-up is needed to add the `coverage` step to CI branch protection so the gate is enforced on every PR,
  not only locally — called out in the #109 PR for the coordinator.
