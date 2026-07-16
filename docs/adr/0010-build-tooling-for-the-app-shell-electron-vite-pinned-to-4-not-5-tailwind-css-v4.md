### ADR-0010: Build tooling for the app shell — `electron-vite` pinned to `^4` (not `^5`) + Tailwind CSS v4
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (build tooling — ARCHITECTURE §1.2 mandates `electron-vite`; `tailwindcss` is
named in MISSION §3. This ADR is the audit note for the *versions* chosen while scaffolding card F1).

**Context**
ARCHITECTURE §1.2 (line 70) requires the shell be "**Built with `electron-vite`** (one config drives the
main / preload / renderer triple build; HMR…)". MISSION §3 pins **Vite** for the renderer. Our lockfile
resolves Vite to the current 5.x line (**5.4**). Two version questions had to be settled to make
`pnpm typecheck` / `pnpm build` pass:
1. **`electron-vite` major.** The newest is `5.x`, but `electron-vite@5`'s own config typings import
   **`BuildEnvironmentOptions`** from Vite — a type that only exists in **Vite 6+**. Against the
   Vite 5.4 we depend on, `tsc --noEmit` of `electron.vite.config.ts` fails on every `build.lib` /
   `build.rollupOptions` field (the symbol is absent from all Vite 5.4 `.d.ts`), even though the config
   runs fine at runtime. Our gate is **zero-warning typecheck**, so a config that doesn't type-check is
   not acceptable.
2. **Tailwind major.** `tailwindcss` is in MISSION §3 with no pinned major; v4 is current.

**Decision**
- Pin **`electron-vite@^4`** (resolved `4.0.1`) — the newest major whose published types are
  **Vite-5-compatible**: its peer range is `vite@^5 || ^6 || ^7`, it does **not** reference
  `BuildEnvironmentOptions`, and each process block is a plain Vite `UserConfig`. Typecheck is clean.
- Adopt **Tailwind CSS v4** with the CSS-first `@theme {}` API (`src/styles/tokens.css`) to express the
  USER_FLOWS §5 design tokens (calm palette, Lora/Inter type scale, spacing, radii, motion) — no
  `tailwind.config.js` needed; tokens live beside the CSS that consumes them.
- Consequence of `electron-vite` + sandbox: the **preload is emitted as CommonJS** (`index.cjs`) and
  **`zod` is bundled into it** (a sandboxed preload cannot `require` from `node_modules`); main and
  renderer stay ESM. The non-default `electron/` + `src/` layout (ARCHITECTURE §1.2) means electron-vite
  auto-discovery is bypassed in favour of explicit `build.lib.entry` / `rollupOptions.input`.

**Alternatives considered**
- *`electron-vite@5` + Vite 5* — **rejected**: fails the typecheck gate (`BuildEnvironmentOptions`).
- *Bump Vite to 6 to satisfy `electron-vite@5`* — **rejected**: MISSION §3 names Vite as the scaffold's
  pinned bundler and the rest of the stack (`@vitejs/plugin-react@^4`) is validated against Vite 5; a
  Vite-major bump is a larger, separate decision, not a scaffolding side-effect.
- *Raw Vite with three hand-rolled configs (no `electron-vite`)* — **rejected**: ARCHITECTURE §1.2
  explicitly mandates `electron-vite`.
- *Tailwind v3 with a JS config* — **rejected**: v4 is current and its `@theme` keeps tokens declarative
  and co-located; no behavioural feature depends on v3.

**Consequences**
- `pnpm typecheck` / `pnpm lint` / `pnpm build` are green on the pinned Vite 5.4 toolchain; the
  main/preload/renderer triple builds from one `electron.vite.config.ts`.
- When the project later moves to **Vite 6+** (its own ADR), `electron-vite` can be bumped to `^5`
  without code changes — purely a tooling refresh.
- `electron@42` has **no `postinstall`**; it self-provisions its binary lazily on the first
  `require('electron')` (i.e. first `pnpm dev` / launch), so a fresh `pnpm install` + `pnpm build` works
  offline and pnpm's build-script gating does not apply to it. See LEARNINGS.
