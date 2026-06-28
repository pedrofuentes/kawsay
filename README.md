# Kawsay

> *Kawsay* — "living energy" in Quechua.

When someone passes, the evidence of their life is scattered across a dozen apps and accounts — WhatsApp threads, photo rolls, cloud drives, emails, social exports. Gathering it all is overwhelming, technical, and emotionally heavy. Kawsay makes it simple, gentle, and **completely private**.

Kawsay is a warm, calm desktop application that helps non-technical people gather a loved one's memories — messages, photos, videos, voice notes, and documents — from data exports into **one private, fully-local archive** that lives entirely on your device. Nothing is uploaded. Nothing leaves your computer.

---

## What Kawsay does

Kawsay imports memories from **data exports and files** (no live account logins required) into a local library: originals preserved on disk, plus a searchable catalog, all built on an extensible connector architecture so new sources are easy to add.

**Sources in v1:**

| Source | What's imported |
|---|---|
| **Folders & cloud downloads** | Any folder of photos, videos, audio, and documents — iCloud Drive, OneDrive, Dropbox, Google Drive downloads, or a local/external disk |
| **WhatsApp** | Export Chat — text, photos, voice notes, audio, and video with a guided walkthrough |
| **Google Takeout** | Gmail (`.mbox`), Google Photos, and Drive contents |
| **Facebook** | "Download Your Information" export |
| **LinkedIn** | "Get a copy of your data" export |

---

## Privacy promise

Kawsay's privacy guarantee is a **core, tested invariant** — not a policy:

- ✅ Everything stays **on your device**
- ✅ **Nothing is uploaded**, synced, or shared
- ✅ **No telemetry**, no analytics, no accounts
- ✅ Originals are **never moved or altered**
- ✅ Fully **offline** — v1 makes zero network connections at runtime

An automated test enforces the zero-egress guarantee on every pull request. See [`MISSION.md`](MISSION.md) §5.

---

## Platforms

| Platform | Status |
|---|---|
| macOS | ✅ Target (`.dmg`) |
| Windows | ✅ Target (`.exe`) |

Distributed via **GitHub Releases** — downloadable installers, no app store, no account required.

---

## Project status

**In active development — M1 MVP in progress.**

The application shell (F1) has landed. We are working toward AC-1 through AC-6 (WhatsApp import, folder/photo import, safe archive extraction, proven zero-egress, macOS + Windows builds, browse/timeline + search). See [`MISSION.md`](MISSION.md) §8 for the full acceptance criteria.

---

## Screenshots

*Screenshots will be added once the UI lands — follow along in the [issue tracker](https://github.com/pedrofuentes/kawsay/issues).*

---

## Getting started (development)

### Prerequisites

- **Node.js** 20 or later
- **pnpm** (install with `npm install -g pnpm`)

### Install and run

```bash
# Install dependencies
pnpm install

# Start the app in development mode (with HMR)
pnpm dev

# Run the full test suite
pnpm test

# Type-check without emitting
pnpm typecheck

# Lint (ESLint — zero warnings expected)
pnpm lint

# Format code (Prettier)
pnpm format

# Build installers for your platform
pnpm build
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Electron](https://www.electronjs.org/) |
| UI | [React 18](https://react.dev/) + [Vite 5](https://vitejs.dev/) + [Tailwind CSS](https://tailwindcss.com/) |
| Language | TypeScript (strict) |
| Local catalog | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (SQLite with FTS5) |
| Photo metadata | [exifr](https://github.com/MikeKovarik/exifr) |
| Email parsing | [mailparser](https://nodemailer.com/extras/mailparser/) |
| Media metadata | ffmpeg / ffprobe (bundled prebuilt binaries) |
| Archive extraction | [yauzl](https://github.com/thejoshwolfe/yauzl) (zip-slip guarded) |
| Validation | [Zod](https://zod.dev/) |
| Tests | [Vitest](https://vitest.dev/) + [Playwright](https://playwright.dev/) |
| Package manager | pnpm |

Heavy ingestion (parsing, hashing, thumbnail generation) runs **off the UI thread** in worker threads and subprocesses, keeping the renderer responsive.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full development workflow, TDD choreography, commit format, and code style guide.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system blueprint — process model, module layout, security invariants, and connector architecture.

## Mission & values

See [`MISSION.md`](MISSION.md) for the product mission, privacy principles, and the definition of done.

---

## License

MIT — see [`LICENSE`](LICENSE).
