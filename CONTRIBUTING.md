# Contributing to Kawsay

Thank you for contributing. Kawsay is a private, fully-local desktop app built with care for people navigating grief — please bring that same care to every change.

This document describes the workflow every contributor follows. [`AGENTS.md`](AGENTS.md) and the [`docs/`](docs/) folder are the authoritative source of truth; this guide summarises the key rules and adds the practical detail you need to get going.

---

## Prerequisites

- **Node.js 20+** — check with `node --version`
- **pnpm** — install with `npm install -g pnpm`, then verify with `pnpm --version`

---

## Commands

```bash
pnpm install        # install all dependencies
pnpm dev            # start the Electron app with HMR
pnpm test           # full Vitest unit + integration suite
pnpm test <file>    # run a single test file (fast feedback loop)
pnpm lint           # ESLint — must be zero warnings
pnpm typecheck      # tsc --noEmit (strict mode)
pnpm format         # Prettier — run before every commit
pnpm build          # electron-builder → .dmg (macOS) / .exe (Windows)
```

---

## Branching — never commit on `main`

All work happens on **worktree branches**, never directly on `main`.

```bash
# create an isolated worktree for your increment
git fetch origin main
git worktree add .worktrees/<name> -b <type>/<short-desc> main
cd .worktrees/<name>
```

Branch naming prefix: `feature/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`

Clean up after merge:

```bash
git worktree remove .worktrees/<name>
git branch -D <branch-name>
```

---

## TDD choreography — required

TDD is non-negotiable. Sentinel (the automated quality gate) rejects non-compliant PRs.

| Step | Commit type | Contents | Suite must… |
|------|-------------|----------|-------------|
| 1 — **RED** | `test(scope): add failing tests` | Tests only | **FAIL** — referencing missing symbol/behaviour |
| 2 — **GREEN** | `feat\|fix(scope): implement` | Minimal impl | **PASS** — all tests |
| 3 — **REFACTOR** | `refactor(scope): ...` | Cleanup only | Stay green |

Rules:
- Never combine test + implementation in one commit.
- Never alter a test to make broken implementation pass.
- `git log --oneline` must show `test(scope)` **before** the corresponding `feat|fix(scope)`.

**Exemptions** (TDD ordering only — Sentinel review still required): `docs`, `chore`, `build`, `ci`, `refactor` (behaviour-preserving), `style` commits. The suite must still pass.

---

## Commit format

```
type(scope): short description

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

**Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `style`, `perf`

The `Co-authored-by` trailer is required on every commit — it is how the Copilot agent's contributions are attributed.

Examples:

```
test(whatsapp): add failing parser tests for voice note entries
feat(whatsapp): parse voice note entries from _chat.txt export
docs: add README, CONTRIBUTING, and MIT LICENSE
```

---

## Pre-push verification

Run these before every `git push` — they catch the most common Sentinel rejections:

```bash
git log --oneline main..HEAD   # verify test(scope) precedes feat|fix(scope)
pnpm test                      # full suite must be green
pnpm lint                      # zero warnings
```

---

## Sentinel review — required before merge

Every PR — including docs-only and one-line fixes — must pass **Sentinel** before it can be merged into `main`. Branch protection enforces the required `sentinel` status check.

Delegated implementers (sub-agents) open the PR and stop. The parent agent or the repository owner invokes Sentinel independently. See [`AGENTS.md`](AGENTS.md) §Sentinel and [`docs/SENTINEL.md`](docs/SENTINEL.md) for the full spec.

---

## Code style

- **TypeScript strict** throughout — `tsconfig.json` has `strict: true`; the linter enforces it.
- **Named exports** — no default exports.
- **Functional React components** — no class components.
- **Isolated connector modules** — each import source is a self-contained module behind a common `Importer` interface; adding a new source means adding a new module, not touching existing ones.
- **Zero network egress** — the app is fully offline at runtime. No fetch calls, no HTTP, no WebSocket, no analytics. This invariant is enforced by an automated test (AC-4) and must never be weakened.
- **Zip-slip / path-traversal guards** — all archive extraction uses `yauzl` with path-traversal checks. Never trust archive entry paths.
- **Heavy work off the UI thread** — ingestion (parsing, hashing, thumbnail generation, ffprobe) runs in worker threads or subprocesses. The renderer main thread must stay responsive (no task > 50 ms during import).
- **Prettier + ESLint** — run `pnpm format` and `pnpm lint` before committing. Zero warnings.

---

## What you must never do

- Transmit, upload, or sync any user memory data off the device.
- Add telemetry, analytics, or any remote call on user content.
- Weaken or remove the local-only guarantee, Sentinel, tests, branch protection, or the security scanners.
- Commit secrets or credentials.
- Force-push or rewrite `main`'s history.
- Combine test + implementation in one commit.
- Edit `AGENTS.md` or `docs/SENTINEL.md` without explicit human-required approval.

---

## Where to learn more

| Document | Read when… |
|----------|------------|
| [`AGENTS.md`](AGENTS.md) | Full autonomous workflow, TDD rules, Sentinel invocation |
| [`docs/SENTINEL.md`](docs/SENTINEL.md) | Before any merge |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Structural changes — process model, module layout, security invariants |
| [`docs/TESTING-STRATEGY.md`](docs/TESTING-STRATEGY.md) | Writing tests |
| [`docs/DEVELOPMENT-WORKFLOW.md`](docs/DEVELOPMENT-WORKFLOW.md) | Workspace setup, parallel work |
| [`MISSION.md`](MISSION.md) | Product mission, privacy principles, definition of done |
| [`DECISIONS.md`](DECISIONS.md) | Technical decisions (ADRs) |
| [`LEARNINGS.md`](LEARNINGS.md) | Discovered knowledge, Sentinel rejection patterns |
