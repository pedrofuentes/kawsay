### ADR-0020: `axe-core` (dev-only) as the holistic accessibility assertion for AC-13
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. The addition is a single **devDependency** — it ships in no production bundle,
opens no network or external origin, and leaves the local-only runtime (ADR-0008, AC-4) untouched; this
ADR is the required audit note.

**Context**
Card X2 is the cross-screen accessibility pass for **AC-13 (WCAG 2.1 AA)**. Prior cards verified each
screen in isolation (per-screen contrast, focus rings, role/label assertions). AC-13 itself is specified
"e2e (axe + Playwright)", but the full Electron e2e harness is not yet wired (`tests/e2e` is empty;
`playwright.config.ts` is a skeleton). A fast, TDD-friendly way was needed to assert **"no serious/critical
axe violations"** holistically — on every primary screen and state — inside the existing `pnpm test` inner
loop, so the AA posture is locked in and cannot silently regress as the UI grows.

**Decision**
Add the dev-only **`axe-core`** engine (pinned `4.12.1`) and a thin helper, `tests/renderer/support/axe.ts`,
that runs axe over a rendered Testing-Library container and fails on any **WCAG 2.1 A/AA** violation
(`runOnly` tags `wcag2a wcag2aa wcag21a wcag21aa`). The new `tests/renderer/accessibility.test.tsx` sweeps
the onboarding wizard (welcome → locate → import progress/complete) and every main view/state (timeline,
search, add-memories, settings) through this helper, alongside targeted assertions for the affordances axe
cannot see under jsdom (skip link, landmark uniqueness, placeholder contrast token, form-error association,
app-wide focus management).

**Alternatives considered**
- **`vitest-axe` / `jest-axe` wrappers**: the obvious ergonomic choice, but `vitest-axe@0.1.0` is stale and
  pulls extra transitive deps (`chalk`, `lodash-es`, `redent`, `aria-query`, `dom-accessibility-api`). This
  repo has a strong, documented pattern of taking the minimal, well-known core and hand-rolling the thin glue
  (ADR-0014 CSV, ADR-0015 router, the U2 debounce). `axe-core` **is** the engine inside both wrappers; adding
  only it keeps the lockfile to one ubiquitous package and the matcher to ~10 lines.
- **Playwright + `@axe-core/playwright` only**: the eventual AC-13 e2e home, but heavy and slow for a TDD
  inner loop and blocked on the not-yet-wired Electron e2e harness. axe-core under jsdom complements (does
  not replace) that future e2e pass.
- **Hand-written role/label assertions only**: already present per-screen; they do not give a single,
  comprehensive "no AA violations" guarantee across every screen, which is exactly AC-13's bar.

**Consequences**
- The renderer suite now fails on any WCAG 2.1 A/AA regression on any covered screen — a durable AC-13 ratchet.
- **jsdom caveat**: axe cannot compute colour-contrast without real layout/canvas, so it reports contrast as
  *incomplete*, never *violation*. Token-pair contrast therefore stays verified against the USER_FLOWS §6.1
  table and is asserted at the class/token level (e.g. the placeholder-contrast test). The future Playwright
  pass will add the real-pixel contrast check.
- **Pinned exact** (not `^`) on purpose: a minor axe bump can introduce new rules that turn a green suite red
  unexpectedly; the version is bumped deliberately, with the new rules reviewed.
- One small, well-known, dev-only package enters the lockfile; it never reaches production or the network.
