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
- **Watchdog:** **Tier-1 only.** **Tier-2 unattended operation is disabled** until a distinct bot
  identity (GitHub App `kawsay-bot[bot]`) is provisioned (MISSION §7 / `docs/CONTINUOUS-OPERATION.md`
  §Agent identity).
- **Board decision channel:** **bounded-trusted** for routine gates (self-signature +
  cofounder-login + solo-repo).
- **Human-required gates:** confirmed **live** — mission/scope/pivots · auth·crypto·credential·privacy
  design · first production deploy/publish of each release · new backend/proxy/external origin ·
  heavy/unusual deps · accepting a high/critical security risk · sending user data off the §5
  allowlist · harness-integrity changes.
- **License:** MIT.

## Delegation ledger

> Invariant: **producer ≠ reviewer**; for gate artifacts, **producer ≠ Delivery Lead**.

| Increment/Artifact | Producer (agent) | Reviewer/Red-teamer (agent) | Ref (PR/SHA) |
|---|---|---|---|
| Phase 0 harness bootstrap | harness-bootstrap (sub-agent) | Delivery Lead (coordinator review) + Sentinel-in-CI henceforth | <commit-sha> |

## In-flight state

Phase 0 complete on commit <sha>; next: Phase 1 (Research+PM → PRD.md/ROADMAP.md + GitHub board).
