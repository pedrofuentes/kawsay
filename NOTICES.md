# Third-party notices

Kawsay bundles the following third-party software. Each component is the
property of its respective authors and is distributed under the license quoted
below. This file satisfies the attribution requirement for redistributed
binaries (AC-23) and records the exact provenance of anything Kawsay compiles
from source and ships inside its installers.

This file lists components whose **binaries are redistributed inside the
packaged app**. Ordinary npm/runtime dependencies are covered by their own
package metadata and `pnpm licenses`, not repeated here.

---

## whisper.cpp — `whisper-cli`

- **Project:** whisper.cpp (<https://github.com/ggml-org/whisper.cpp>)
- **Component bundled:** the `whisper-cli` command-line executable (and the
  `ggml`/`whisper` code statically linked into it).
- **License:** MIT (full text below).
- **Pinned version:** `v1.9.1`
- **Pinned commit:** `f049fff95a089aa9969deb009cdd4892b3e74916`
- **How it is obtained:** built **from source in CI** (not downloaded as a
  prebuilt binary) for each shipped target — macOS arm64, macOS x64, and
  Windows x64 — by `scripts/build-whisper-cli.sh`, then bundled per-arch under
  `resources/whisper/<os>-<arch>/` via electron-builder `extraResources`. See
  ADR-0027 in `DECISIONS.md`.

No speech-recognition **model** is bundled with the binary; models are a
separate, opt-in download handled outside the installer.

```
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
