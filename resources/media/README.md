# `resources/media/`

This directory is where the per-arch **`ffmpeg`** and **`ffprobe`** executables
are staged so electron-builder can bundle them into the packaged app (#175).
`ffmpeg` extracts audio for transcription and renders video poster frames;
`ffprobe` reads media metadata during ingestion.

The binaries are **staged at build time, never committed**:

```
resources/media/
├── mac-arm64/{ffmpeg,ffprobe}       # macOS Apple Silicon
├── mac-x64/{ffmpeg,ffprobe}         # macOS Intel
└── win-x64/{ffmpeg.exe,ffprobe.exe} # Windows x64
```

## How it gets here

`scripts/stage-media-binaries.mjs` copies the **correct-arch** binary for each
shipped build leg out of the [`@ffmpeg-installer`](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg)
and [`@ffprobe-installer`](https://www.npmjs.com/package/@ffprobe-installer/ffprobe)
packages — which ship prebuilt binaries as plain files (no download-on-install)
— into `resources/media/<os>-<arch>/`. `pnpm`'s `supportedArchitectures`
(package.json) installs all three target packages on every runner, so a single
arm64 macOS runner can stage the **x64** dmg's binaries too, closing the
cross-arch gap.

It runs automatically via the `predev` / `predist*` npm hooks, and explicitly in
CI (`pnpm stage:media`) before packaging. `electron-builder.yml`'s
`extraResources` then bundles `resources/media/${os}-${arch}/` per build leg, so
each installer carries **only its own-arch** binaries.

The layout (`<os>-<arch>`, basename `ffmpeg[.exe]` / `ffprobe[.exe]`) is the
exact contract the runtime resolver in
`electron/main/importers/deps/media-binaries.ts` expects, so the packaged app can
spawn the binaries via `process.resourcesPath`.

## Why not `ffmpeg-static` / `ffprobe-static`?

v0.2.0 shipped with **no ffmpeg at all** — `ffmpeg-static` downloads its binary
in a postinstall script that pnpm blocks by default — and a **wrong-arch
ffprobe** (`ffprobe-static@3.1.0` mislabelled its Mach-O x86_64 binary as
`darwin/arm64`). The installer packages above ship real, correct-arch files, and
the CI guard `scripts/verify-media-binaries.mjs` now **fails the build** if any
staged binary is missing or the wrong arch, so this can never silently ship
again.

## Staging locally

```bash
pnpm stage:media        # stage this host's build-leg targets
node scripts/verify-media-binaries.mjs   # assert they exist + correct arch
```

The staged binaries are git-ignored.
