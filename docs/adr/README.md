# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for the Kawsay project. Each ADR documents a significant technical decision, the context that prompted it, the decision made, and its consequences.

ADRs are organized numerically by ID. For context on the ADR format and authorization tiers, see [`../DECISIONS.md`](../DECISIONS.md).

## Index

| # | Title | Status |
|---|-------|--------|
| **ADR-0030** | [M4-2 + M4-3 — Categorization & Suggested Collections (implementation design)](./0030-m4-2-m4-3-categorization-suggested-collections-implementation-design.md) | Proposed |
| **ADR-0029** | [M4 — On-device AI categorization & smart search (design)](./0029-m4-on-device-ai-categorization-smart-search-design.md) | Accepted |
| **ADR-0028** | [M3 iMessage/SMS first slice reads local macOS Messages `chat.db` directly](./0028-m3-imessagesms-first-slice-reads-local-macos-messages-chatdb-directly.md) | Accepted |
| **ADR-0027** | [M2 on-device transcription — whisper.cpp via bundled binary + opt-in model download](./0027-m2-on-device-transcription-whispercpp-via-a-bundled-whisper-cli-binary-an-opt-in-on-demand-checks*.md) | Accepted |
| **ADR-0026** | [Release pipeline — GitHub Actions workflow publishing unsigned v1 installers](./0026-release-pipeline-github-actions-workflow-publishing-unsigned-v1-installers-to-github-releases.md) | Accepted |
| **ADR-0025** | [Defer enableEmbeddedAsarIntegrityValidation to the signed build](./0025-defer-enableembeddedasarintegrityvalidation-to-the-signed-build.md) | Accepted |
| **ADR-0024** | [Bump better-sqlite3 12.9.0 → 12.11.1 for Electron 42 native compatibility](./0024-bump-better-sqlite3-1290-12111-for-electron-42-native-compatibility.md) | Accepted |
| **ADR-0023** | [Packaging finalization — fuse-flip mechanism, non-publishing auto-builds, ABI ordering](./0023-packaging-finalization-card-p1-fuse-flip-mechanism-non-publishing-auto-builds-abi-ordering.md) | Accepted |
| **ADR-0022** | [Thumbnails travel as bounded `data:` URLs over zod-validated IPC channel](./0022-thumbnails-travel-as-bounded-data-urls-over-a-zod-validated-catalogthumbnail-ipc-channel.md) | Accepted |
| **ADR-0021** | [`@vitest/coverage-v8` (dev-only) wires the ≥80% coverage gate](./0021-vitestcoverage-v8-dev-only-wires-the-80-coverage-gate-the-dod-already-required.md) | Accepted |
| **ADR-0020** | [`axe-core` (dev-only) as the holistic accessibility assertion](./0020-axe-core-dev-only-as-the-holistic-accessibility-assertion-for-ac-13.md) | Accepted |
| **ADR-0017** | [Clear dev-dependency CVEs via `pnpm.overrides` + Vite 5→6 bump](./0017-clear-the-dev-dependency-cves-via-pnpmoverrides-patched-taresbuild-a-vite-56-bump.md) | Accepted |
| **ADR-0016** | [jsdom + Testing Library (dev-only) to drive renderer test-first](./0016-jsdom-testing-library-dev-only-to-drive-the-renderer-test-first.md) | Accepted |
| **ADR-0015** | [Dependency-free typed view router for the renderer](./0015-dependency-free-typed-view-router-for-the-renderer-no-react-router-dom.md) | Accepted |
| **ADR-0014** | [Hand-rolled RFC 4180 CSV reader for LinkedIn importer](./0014-hand-rolled-rfc-4180-csv-reader-for-the-linkedin-importer-no-csv-parsepapaparse-dependency.md) | Accepted |
| **ADR-0013** | [Revert Takeout email tooling to `mailparser` + in-module streaming splitter](./0013-revert-takeout-email-tooling-to-mailparser-an-in-module-streaming-from-delimited-splitter-superse*.md) | Accepted |
| **ADR-0012** | [Media-ingestion dependencies + off-thread ingestion engine](./0012-media-ingestion-dependencies-exifr-fluent-ffmpeg-ffmpeg-static-ffprobe-static-the-off-thread-inge*.md) | Accepted |
| **ADR-0011** | [`nock` as the http(s) layer of the AC-4 zero-egress test harness](./0011-nock-as-the-https-layer-of-the-ac-4-zero-egress-test-harness.md) | Accepted |
| **ADR-0010** | [Build tooling — `electron-vite` + Tailwind CSS v4](./0010-build-tooling-for-the-app-shell-electron-vite-pinned-to-4-not-5-tailwind-css-v4.md) | Accepted |
| **ADR-0009** | [Takeout `.mbox` streaming split + email-parser substitution](./0009-takeout-mbox-streaming-split-email-parser-substitution-mailparser-mbox-parser-postal-mime.md) | Accepted |
| **ADR-0008** | [Privacy, data location & the local-only / zero-egress invariant](./0008-privacy-data-location-the-local-only-zero-egress-invariant.md) | Accepted |
| **ADR-0007** | [Packaging & distribution via electron-builder → GitHub Releases](./0007-packaging-distribution-via-electron-builder-github-releases.md) | Accepted |
| **ADR-0006** | [Safe untrusted-archive extraction (yauzl) + stable ERR_ARCHIVE_* codes](./0006-safe-untrusted-archive-extraction-yauzl-stable-err_archive_-codes.md) | Accepted |
| **ADR-0005** | [Electron security hardening + minimal contextBridge IPC surface](./0005-electron-security-hardening-minimal-contextbridge-ipc-surface.md) | Accepted |
| **ADR-0004** | [Off-UI-thread ingestion (worker threads + ffmpeg/ffprobe subprocess)](./0004-off-ui-thread-ingestion-worker-threads-ffmpegffprobe-subprocess.md) | Accepted |
| **ADR-0003** | [Local catalog — better-sqlite3 schema + migration runner + dedup-with-provenance](./0003-local-catalog-better-sqlite3-schema-migration-runner-originals-on-disk-dedup-with-provenance.md) | Accepted |
| **ADR-0002** | [Extensible connector (importer) interface](./0002-extensible-connector-importer-interface.md) | Accepted |
| **ADR-0001** | [Application shell — Electron + React + Vite + Tailwind](./0001-application-shell-electron-react-vite-tailwind-main-preload-renderer.md) | Accepted |

> **Note**: ADR-0018 and ADR-0019 are reserved but not yet documented. ADRs are listed in reverse chronological order (newest first).

## How to Read

1. Each ADR is self-contained in a single `.md` file.
2. Search for an ADR by ID (e.g., "ADR-0008") to jump to its discussion.
3. For context on the ADR format and authorization tiers, see [`../DECISIONS.md`](../DECISIONS.md).

## Adding a New ADR

1. Create a new file in this directory: `docs/adr/NNNN-kebab-case-title.md` (zero-padded ADR number).
2. Use the format documented in `DECISIONS.md` (or copy an existing ADR as a template).
3. Add an entry to this index in reverse chronological (newest-first) order.
4. Update `DECISIONS.md` if necessary.
