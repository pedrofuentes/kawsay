# Kawsay — Build Coordinator PLAN

> Harness coordinator ledger, audited by the watchdog. This is the durable build-coordination
> record — **distinct from any per-session plan**. It tracks capabilities, operating posture,
> delegation, and in-flight state for the autonomous build of Kawsay.

## Capabilities

capabilities: full

- Delegation probe: **L1 ok** (coordinator → sub-agent), **nested ok** (sub-agent → sub-sub-agent).
- Full-capability sub-agents are available for implementation, Sentinel review, and research.

## Operating posture

- **Mode:** attended single-operator — the coordinator runs under the operator's **own identity
  (@pedrofuentes)** while present (MISSION §7). Gate answers are taken via the live CLI or a
  bounded-trusted async board channel.
- **Watchdog:** **Tier-1 ARMED** — 20-minute recurring heartbeat (`manage_schedule`) running the
  canonical steps 0–8, adapted for **Method A** (Sentinel sub-agent review). **Tier-2 unattended
  operation is DISABLED** — no bot identity / no model API key. This is a deliberate choice per
  `docs/CONTINUOUS-OPERATION.md` v2.9.1: an always-on machine prefers persistent Tier-1.
- **Review method:** **Method A** — the coordinator invokes Sentinel as an independent non-author
  sub-agent per PR. There is **no `sentinel` CI check**.
- **Board sync:** **labels-only** — the PAT lacks `project` scope, so labels + issue open/closed
  state are the source of truth. The Status-column mirror is gated on issue #301 (`blocked`,
  non-blocking).
- **Board decision channel:** **bounded-trusted** for routine gates (self-signature +
  cofounder-login + solo-repo).
- **Human-required gates:** confirmed **live** — mission/scope/pivots · auth·crypto·credential·privacy
  design · first production deploy/publish of each release · new backend/proxy/external origin ·
  heavy/unusual deps · accepting a high/critical security risk · sending user data off the §5
  allowlist · harness-integrity changes.
- **License:** MIT.

## Delegation ledger

> Invariant: **producer ≠ reviewer**; for gate artifacts, **producer ≠ Delivery Lead**.

Recent merged PRs (representative sample — each built by a delegated implementer sub-agent,
reviewed by an independent non-author Sentinel sub-agent, then merged by a non-author merge
agent):

| PR | Producer | Reviewer | Summary |
|---|---|---|---|
| #300 | delegated implementer (sub-agent) | Sentinel — Method A non-author sub-agent | template sync v2.9.2 |
| #299 | delegated implementer (sub-agent) | Sentinel — Method A non-author sub-agent | template sync v2.9.1 |
| #296 | delegated implementer (sub-agent) | Sentinel — Method A non-author sub-agent | model-download AbortSignal |
| #295 | delegated implementer (sub-agent) | Sentinel — Method A non-author sub-agent | renderer-egress safeguard |
| #294 | delegated implementer (sub-agent) | Sentinel — Method A non-author sub-agent | permissions indent-0 anchor |
| #293 | delegated implementer (sub-agent) | Sentinel — Method A non-author sub-agent | checkout-drift detection |
| #290 | delegated implementer (sub-agent) | Sentinel — Method A non-author sub-agent | renderer-egress Playwright |

## In-flight state

- **Product:** v0.4.0 shipped (smart search / M4-1b live).
- **Backlog:** Sentinel advisory issues closed; actionable ones dispatched to the ready queue.
- **Next milestone:** M4-2 (Categorization) + M4-3 (Suggested Collections) — board cards #263–#273
  (labeled `m4`).
- **Current gates:** M4-2/M4-3 gated at migration-005 root (#263) + gazetteer (#266); also #6
  (foundation-reconcile), #37 (security.yml), #247 (require-hashes), #301 (board-scope).
- **Tier-1 watchdog:** running (20m heartbeat).
- **Wave-1 workers:** in-flight PRs for #212, #209, and combined #297/#298/#235.

## HANDOFF

> For a cold successor who reads `docs/KICKOFF.md` + `docs/MISSION.md` + this block.

### Runtime & Capabilities

- **Runtime:** autonomous-kickoff v2.9.2 (origin/main HEAD `9e3eed2`, 2026-07-04).
- **Capabilities:** full — L1 (coordinator→sub-agent) and nested (sub-agent→sub-sub-agent) delegation
  confirmed working; full-capability general-purpose sub-agents available for implementation,
  Sentinel review, and research.
- **Git identity:** author `pedrofuentes <git@pedrofuent.es>`, commit trailer
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

### Armed Schedules

- **Tier-1 watchdog:** 20-minute recurring (`manage_schedule`) running canonical steps 0–8,
  adapted for Method A Sentinel review. Tier-2 unattended operation DISABLED (no bot identity /
  no model API key — per `docs/CONTINUOUS-OPERATION.md` v2.9.1, an always-on machine prefers
  persistent Tier-1).

### In-Flight Increments

- **Wave-1 workers:** PRs open for #212, #209, and combined #297/#298/#235. Awaiting Sentinel
  review + merge (Method A).

### Pending Gates

- **#263** (migration-005 root) — blocks M4-2/M4-3 start.
- **#266** (gazetteer) — blocks M4-2/M4-3 start.
- **#6** (foundation-reconcile) — architectural hygiene.
- **#37** (security.yml workflow) — supply-chain hardening.
- **#247** (require-hashes) — lockfile integrity.
- **#301** (board-scope PAT) — Status-column mirror (non-blocking).

### Governance Profile

- **MISSION §9:** standard/conservative — roadmap-exhaustion = stop; production release =
  human-required; network egress/backend/telemetry → human-required or never.
- **MISSION §10 caps:** 4 concurrent workers · 3 spawns/tick · 30 spawns/milestone · 240
  Actions-min/day · 5 auto-proceeded time-boxed gates/milestone · 2 consecutive auto-proceeded
  milestones · 7-day dead-man switch.

### Single Next Action

**Sentinel-review + merge the wave-1 PRs as they land (Method A), then advance the ready queue
or await gate answers; stop only at project DoD or `agent:halt`.**
