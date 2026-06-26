#!/usr/bin/env bash
#
# build-whisper-cli.sh — compile whisper.cpp's `whisper-cli` from source, per-arch,
# and stage each binary where electron-builder's extraResources picks it up:
#
#     resources/whisper/<os>-<arch>/whisper-cli[.exe]
#
# This is the single build entry point shared by CI (.github/workflows/ci.yml,
# release.yml) and local use. It is intentionally Electron-free and matches the
# runtime resolver in electron/main/transcription/whisper-cli.ts (same
# <os>-<arch> layout, same basename). See ADR-0027 in DECISIONS.md.
#
# The whisper.cpp source is PINNED to an immutable commit (not a floating tag):
# the tag is fetched, then HEAD is asserted to equal WHISPER_CPP_COMMIT, so a
# re-pointed or deleted upstream tag fails the build loudly instead of shipping
# unexpected source. Override the pin via the WHISPER_CPP_* env vars below
# (CI sets them once so the workflow YAML is the single source of truth).
#
# Cross-platform notes (verified by CI, not locally — see PR body):
#   * GGML_NATIVE=OFF      → do NOT bake the CI runner's CPU instructions into a
#                            distributed binary (would SIGILL on older user CPUs).
#   * BUILD_SHARED_LIBS=OFF → static libwhisper/ggml; no sidecar .dll/.dylib.
#   * macOS builds BOTH arm64 and x86_64 on one runner (mirrors better-sqlite3),
#     each with Metal embedded so the binary is self-contained.
#   * Windows links the MSVC runtime dynamically (default /MD); any machine that
#     can run the Kawsay Electron app already ships that runtime.
#
set -euo pipefail

# --- pinned source of truth (overridable by CI for a single pin location) -----
WHISPER_CPP_REPO="${WHISPER_CPP_REPO:-ggml-org/whisper.cpp}"
WHISPER_CPP_REF="${WHISPER_CPP_REF:-v1.9.1}"
WHISPER_CPP_COMMIT="${WHISPER_CPP_COMMIT:-f049fff95a089aa9969deb009cdd4892b3e74916}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT_BASE="$REPO_ROOT/resources/whisper"
WORK_DIR="${WHISPER_BUILD_DIR:-$REPO_ROOT/.whisper-build}"
SRC_DIR="$WORK_DIR/src"

log()  { printf '\n\033[1m[whisper-cli]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m[whisper-cli] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- detect OS key (mirrors the resolver's mac|win mapping) -------------------
case "${RUNNER_OS:-$(uname -s)}" in
  macOS|Darwin)                  OS_KEY=mac ;;
  Windows|MINGW*|MSYS*|CYGWIN*)  OS_KEY=win ;;
  Linux)
    die "Kawsay ships macOS + Windows only; whisper-cli is not built for Linux." ;;
  *)
    die "Unsupported OS: ${RUNNER_OS:-$(uname -s)}" ;;
esac

# --- per-OS arch matrix: "<electron-builder arch>:<CMAKE_OSX_ARCHITECTURES>" ---
case "$OS_KEY" in
  mac) TARGETS=("arm64:arm64" "x64:x86_64") ;;
  win) TARGETS=("x64:") ;;
esac

command -v cmake >/dev/null 2>&1 || die "cmake not found on PATH"
command -v git   >/dev/null 2>&1 || die "git not found on PATH"

# --- clone + verify the immutable pin ----------------------------------------
if [ ! -d "$SRC_DIR/.git" ]; then
  log "Cloning $WHISPER_CPP_REPO @ $WHISPER_CPP_REF (shallow)"
  rm -rf "$SRC_DIR"
  mkdir -p "$WORK_DIR"
  git clone --depth 1 --branch "$WHISPER_CPP_REF" \
    "https://github.com/$WHISPER_CPP_REPO.git" "$SRC_DIR"
else
  log "Reusing existing checkout at $SRC_DIR"
fi

HEAD_SHA="$(git -C "$SRC_DIR" rev-parse HEAD)"
if [ "$HEAD_SHA" != "$WHISPER_CPP_COMMIT" ]; then
  die "Pinned ref drift: $WHISPER_CPP_REF resolved to $HEAD_SHA but expected $WHISPER_CPP_COMMIT"
fi
log "Pinned commit verified: $HEAD_SHA"

verify_one() {
  local eb_arch="$1" osx_arch="$2" dest="$3"
  [ -s "$dest" ] || die "staged binary is empty: $dest"

  # macOS: confirm the produced Mach-O is the arch we asked for (no execution).
  if [ "$OS_KEY" = mac ]; then
    local archs=""
    if command -v lipo >/dev/null 2>&1; then
      archs="$(lipo -archs "$dest" 2>/dev/null || true)"
    fi
    [ -n "$archs" ] || archs="$(file -b "$dest" 2>/dev/null || true)"
    case "$osx_arch" in
      arm64)  echo "$archs" | grep -q "arm64"  || die "expected arm64 binary, got: $archs" ;;
      x86_64) echo "$archs" | grep -q "x86_64" || die "expected x86_64 binary, got: $archs" ;;
    esac
    log "arch verified ($eb_arch): $archs"
  fi

  # Smoke test only the binary matching the host arch (cross-built ones may need
  # an emulator). `--help` prints "usage:" and exit(0), so this proves the binary
  # actually loads (no missing dylib/dll) and runs.
  local host runnable=0
  host="$(uname -m)"
  case "$OS_KEY:$host:$eb_arch" in
    mac:arm64:arm64) runnable=1 ;;
    mac:x86_64:x64)  runnable=1 ;;
    win:*:x64)       runnable=1 ;;
  esac
  if [ "$runnable" = 1 ]; then
    local out
    if out="$("$dest" --help 2>&1)"; then
      echo "$out" | grep -qi "usage:" || die "smoke test: --help did not print usage"
      log "smoke test passed ($eb_arch): launches + prints usage"
    else
      die "smoke test: '$dest --help' failed to launch"
    fi
  fi
}

build_one() {
  local eb_arch="$1" osx_arch="$2"
  local arch_dir="$OS_KEY-$eb_arch"
  local exe=""; [ "$OS_KEY" = win ] && exe=".exe"
  local dest_dir="$OUT_BASE/$arch_dir"
  local dest="$dest_dir/whisper-cli$exe"

  if [ -f "$dest" ] && [ -z "${WHISPER_FORCE_REBUILD:-}" ]; then
    log "$arch_dir: already present, skipping (set WHISPER_FORCE_REBUILD=1 to force)"
    return 0
  fi

  local build_dir="$WORK_DIR/build-$arch_dir"
  log "$arch_dir: configuring"
  local -a cfg=(
    -S "$SRC_DIR" -B "$build_dir"
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_SHARED_LIBS=OFF
    -DGGML_NATIVE=OFF
    -DWHISPER_BUILD_TESTS=OFF
    -DWHISPER_BUILD_EXAMPLES=ON
    -DWHISPER_BUILD_SERVER=OFF
  )
  if [ "$OS_KEY" = mac ]; then
    cfg+=(
      -DCMAKE_OSX_ARCHITECTURES="$osx_arch"
      -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
      -DGGML_METAL=ON
      -DGGML_METAL_EMBED_LIBRARY=ON
    )
  elif [ "$OS_KEY" = win ]; then
    # Default VS generator is multi-config; pin the platform explicitly.
    cfg+=(-A x64)
  fi

  cmake "${cfg[@]}"

  log "$arch_dir: building whisper-cli"
  cmake --build "$build_dir" --config Release --target whisper-cli -j

  # Locate the binary across single-config (bin/) and multi-config (bin/Release/)
  # generator layouts; CMAKE_RUNTIME_OUTPUT_DIRECTORY is build/bin upstream.
  local bin
  bin="$(find "$build_dir/bin" -type f -name "whisper-cli$exe" 2>/dev/null | head -1 || true)"
  [ -n "$bin" ] || die "$arch_dir: built binary not found under $build_dir/bin"

  mkdir -p "$dest_dir"
  cp "$bin" "$dest"
  [ "$OS_KEY" = win ] || chmod +x "$dest"

  verify_one "$eb_arch" "$osx_arch" "$dest"
  log "$arch_dir: staged at $dest"
}

mkdir -p "$OUT_BASE"
for t in "${TARGETS[@]}"; do
  build_one "${t%%:*}" "${t##*:}"
done

log "done — staged binaries under $OUT_BASE"
