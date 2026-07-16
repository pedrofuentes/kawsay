### ADR-0015: Dependency-free typed view router for the renderer (no `react-router-dom`)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (card U3 pre-authorized adding `react-router-dom` as auto-with-audit; this ADR is
the required audit note for choosing instead to add **no** dependency). Adds no network egress, backend, or
external origin, so the local-only invariant (ADR-0008, AC-4) is untouched.

**Context**
Card U3 builds the first real renderer: onboarding (welcome → name → library location → source →
walkthrough → locate → import) plus a main app shell with a handful of sections (Timeline, Search, Add
memories, Settings). The renderer needs a way to move between these views, and U1/U2 need a way to add
their own screens. Kawsay is a single-window, fully-offline Electron app with no URLs, no deep-linking, no
server-side routing, and a deliberately small, finite set of screens.

**Decision**
Use a hand-rolled, **fully-typed view-state router** built on React context: a `View` discriminated union
(`{ name: 'onboarding' | 'timeline' | 'search' | 'add-memories' | 'settings' }`), a `NavigationProvider`
holding the current view, and a `useNavigation()` hook exposing `{ view, navigate }`. Onboarding's internal
step machine (`welcome → … → import`) is local state within `OnboardingFlow`. No routing library is added.

**Alternatives considered**
- **`react-router-dom`** (pre-authorized): mature and familiar, but built around URLs / history / deep-
  linking that a single-window offline desktop app does not have. It would add a dependency (and its
  transitive surface) to express what a ~20-line typed union already expresses, invite URL-shaped patterns
  that do not map to this app, and grow the bundle for no user-visible benefit.
- **A state-machine library (XState, etc.)**: far more than a few-screen calm app needs; rejected on the
  same zero-dep, low-complexity grounds.

**Consequences**
- Zero new runtime dependencies; nothing to audit for egress; smaller bundle; the navigation surface is
  exhaustively typed (adding a screen is a compile error until every `switch` handles it).
- U1 (timeline) and U2 (search) extend navigation by adding a member to the `View` union and a `case` in
  the renderer — no router config, loaders, or path strings.
- No URL / deep-link / back-forward history semantics. If a future card needs genuine deep-linking or many
  dozens of screens, this ADR can be superseded; for the current and foreseeable scope the typed union is
  simpler and safer.
