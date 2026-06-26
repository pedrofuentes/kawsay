# `resources/whisper/`

This directory is where the per-arch **`whisper-cli`** executable is staged so
electron-builder can bundle it into the packaged app (ADR-0027 · #129).

The binaries are **built from source in CI**, never committed:

```
resources/whisper/
├── mac-arm64/whisper-cli       # macOS Apple Silicon
├── mac-x64/whisper-cli         # macOS Intel
└── win-x64/whisper-cli.exe     # Windows x64
```

## How it gets here

`scripts/build-whisper-cli.sh` clones whisper.cpp at the pinned ref
(`v1.9.1` / commit `f049fff95a089aa9969deb009cdd4892b3e74916`), verifies the
commit, builds the `whisper-cli` target with CMake for each shipped arch, and
copies the result into `resources/whisper/<os>-<arch>/`. CI runs it on the
macOS and Windows runners before packaging; `.github/workflows/release.yml`
bundles the output via `electron-builder.yml`'s `extraResources`.

The layout (`<os>-<arch>`, basename `whisper-cli[.exe]`) is the exact contract
the runtime resolver in `electron/main/transcription/whisper-cli.ts` expects,
so the packaged app can spawn the binary via `process.resourcesPath`.

## Building locally

```bash
./scripts/build-whisper-cli.sh
```

Requires `cmake` and `git` on `PATH` (plus Xcode command-line tools on macOS or
Visual Studio Build Tools on Windows). The compiled binaries and the
`.whisper-build/` work directory are git-ignored.

> No speech-recognition **model** lives here — models are a separate, opt-in
> download handled outside the installer.
