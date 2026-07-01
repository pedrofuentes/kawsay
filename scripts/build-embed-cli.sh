#!/usr/bin/env bash
#
# build-embed-cli.sh — compile llama.cpp's `llama-embedding` from source, per-arch,
# and stage each binary where electron-builder's extraResources picks it up:
#
#     resources/embed/<os>-<arch>/llama-embedding[.exe]
#
# This is the on-device text-embedding engine for M4 smart search (ADR-0029
# Decision 1, milestone M4-1b). It is the exact sibling of scripts/build-whisper-
# cli.sh (same <os>-<arch> layout, same static/self-contained posture) and matches
# the runtime resolver in electron/main/search/embed-cli.ts (EMBED_RESOURCE_SUBDIR
# = 'embed', basename `llama-embedding`). NO model ships here — the GGUF is a
# separate, later opt-in slice; this script builds ONLY the binary.
#
# The llama.cpp source is PINNED to an immutable commit (not a floating tag): the
# tag is fetched, then HEAD is asserted to equal LLAMA_CPP_COMMIT, so a re-pointed
# or deleted upstream tag fails the build loudly instead of shipping unexpected
# source. Override the pin via the LLAMA_CPP_* env vars below (CI sets them once so
# the workflow YAML is the single source of truth).
#
# Cross-platform notes (verified by CI, not locally — see PR body):
#   * GGML_NATIVE=OFF      → do NOT bake the CI runner's CPU instructions into a
#                            distributed binary (would SIGILL on older user CPUs).
#   * BUILD_SHARED_LIBS=OFF → static libllama/ggml; no sidecar .dll/.dylib.
#   * Only the `llama-embedding` example is built (tools, server, the unified app
#     binary and its Web UI are all OFF) — smaller, faster, and it avoids any
#     build-time network fetch of a prebuilt UI (zero-egress hygiene, AC-4).
#   * Built NETWORK-FREE (LLAMA_OPENSSL=OFF): `common` unconditionally links
#     cpp-httplib, which at this pinned commit compiles WITH OpenSSL HTTPS support
#     whenever CMake's LLAMA_OPENSSL (default ON) finds a host OpenSSL — so the
#     binary would link libssl/libcrypto. The embedder only reads a LOCAL `-m`
#     GGUF (Kawsay does its own consent-gated model fetch), so we force it OFF: the
#     statically-linked httplib then carries NO TLS/HTTP code and the binary links
#     zero libssl/libcrypto/curl (AC-4 zero-egress). This ALSO fixes the macOS
#     x86_64 cross-link, which otherwise fails resolving OpenSSL symbols the arm64
#     runner's host OpenSSL can't provide for x86_64. (LLAMA_CURL is deprecated/
#     ignored at this pin — LLAMA_OPENSSL is the real control.)
#   * macOS ships BOTH arm64 and x86_64 (dual-arch layout mirrors whisper-cli),
#     built CPU-only — Metal is intentionally OFF (unlike whisper-cli): this is a
#     tiny background embedder, so CPU inference is plenty fast. Set EMBED_ARCH
#     (or pass the arch as $1) to build a SINGLE arch — CI's embed-cli matrix
#     builds one (os, arch) per PARALLEL leg so the two macOS arches no longer
#     compile back-to-back on one runner (which overran the job timeout). Release
#     + local builds leave EMBED_ARCH unset to stage every arch in one pass. See
#     the mac cfg block for the Metal rationale.
#   * Windows links the MSVC runtime dynamically (default /MD); any machine that
#     can run the Kawsay Electron app already ships that runtime.
#
set -euo pipefail

# --- pinned source of truth (overridable by CI for a single pin location) -----
LLAMA_CPP_REPO="${LLAMA_CPP_REPO:-ggml-org/llama.cpp}"
LLAMA_CPP_REF="${LLAMA_CPP_REF:-b9848}"
LLAMA_CPP_COMMIT="${LLAMA_CPP_COMMIT:-931eb37f8cac5a6ca84d5641445d460af2a9d7dd}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT_BASE="$REPO_ROOT/resources/embed"
WORK_DIR="${LLAMA_BUILD_DIR:-$REPO_ROOT/.llama-build}"
SRC_DIR="$WORK_DIR/src"

log()  { printf '\n\033[1m[embed-cli]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m[embed-cli] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- detect OS key (mirrors the resolver's mac|win mapping) -------------------
case "${RUNNER_OS:-$(uname -s)}" in
  macOS|Darwin)                  OS_KEY=mac ;;
  Windows|MINGW*|MSYS*|CYGWIN*)  OS_KEY=win ;;
  Linux)
    die "Kawsay ships macOS + Windows only; llama-embedding is not built for Linux." ;;
  *)
    die "Unsupported OS: ${RUNNER_OS:-$(uname -s)}" ;;
esac

# --- per-OS arch matrix: "<electron-builder arch>:<CMAKE_OSX_ARCHITECTURES>" ---
case "$OS_KEY" in
  mac) ALL_TARGETS=("arm64:arm64" "x64:x86_64") ;;
  win) ALL_TARGETS=("x64:") ;;
esac

# Optional single-arch selector. CI's embed-cli matrix builds ONE arch per leg —
# each (os, arch) in its own parallel job with its own timeout budget — by setting
# EMBED_ARCH (or passing the arch as $1). That is what stopped the macOS build from
# compiling arm64 + x86_64 back-to-back on one runner and overrunning the timeout.
# Left UNSET (release packaging + local dev-builds) it builds EVERY arch for the
# OS, so electron-builder still stages both mac arches from a single pass.
ARCH_FILTER="${EMBED_ARCH:-${1:-}}"
if [ -n "$ARCH_FILTER" ]; then
  TARGETS=()
  for t in "${ALL_TARGETS[@]}"; do
    [ "${t%%:*}" = "$ARCH_FILTER" ] && TARGETS+=("$t")
  done
  [ "${#TARGETS[@]}" -gt 0 ] \
    || die "EMBED_ARCH='$ARCH_FILTER' is not a valid arch for $OS_KEY (valid: ${ALL_TARGETS[*]%%:*})"
  log "single-arch build requested: $ARCH_FILTER"
else
  TARGETS=("${ALL_TARGETS[@]}")
fi

command -v cmake >/dev/null 2>&1 || die "cmake not found on PATH"
command -v git   >/dev/null 2>&1 || die "git not found on PATH"

# Bound compile parallelism to the core count. `cmake --build -j` with NO number
# maps to `make -j` (UNBOUNDED) under the default macOS "Unix Makefiles" generator:
# it launches one compiler per translation unit at once, which on the memory-limited
# (~7 GB) macOS CI runner thrashes into swap — a big contributor to the dual-arch
# build overrunning its timeout. A fixed core-count cap keeps every core busy without
# the swap storm (and is harmless on Windows/MSVC, which bounds itself already).
if command -v nproc >/dev/null 2>&1; then
  JOBS="$(nproc)"
elif command -v sysctl >/dev/null 2>&1; then
  JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
else
  JOBS="${NUMBER_OF_PROCESSORS:-4}"
fi
case "$JOBS" in ''|*[!0-9]*) JOBS=4 ;; esac
[ "$JOBS" -ge 1 ] || JOBS=4

# --- clone + verify the immutable pin ----------------------------------------
if [ ! -d "$SRC_DIR/.git" ]; then
  log "Cloning $LLAMA_CPP_REPO @ $LLAMA_CPP_REF (shallow)"
  rm -rf "$SRC_DIR"
  mkdir -p "$WORK_DIR"
  git clone --depth 1 --branch "$LLAMA_CPP_REF" \
    "https://github.com/$LLAMA_CPP_REPO.git" "$SRC_DIR"
else
  log "Reusing existing checkout at $SRC_DIR"
fi

HEAD_SHA="$(git -C "$SRC_DIR" rev-parse HEAD)"
if [ "$HEAD_SHA" != "$LLAMA_CPP_COMMIT" ]; then
  die "Pinned ref drift: $LLAMA_CPP_REF resolved to $HEAD_SHA but expected $LLAMA_CPP_COMMIT"
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
  # an emulator). `--help` prints the option sections (including the embedding
  # flags our wrapper depends on) and exit(0), so this proves the binary actually
  # loads (no missing dylib/dll) and runs.
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
      echo "$out" | grep -qiE -- '--embd-normalize|--pooling' \
        || die "smoke test: --help did not list the expected embedding flags"
      log "smoke test passed ($eb_arch): launches + prints embedding help"
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
  local dest="$dest_dir/llama-embedding$exe"

  if [ -f "$dest" ] && [ -z "${LLAMA_FORCE_REBUILD:-}" ]; then
    log "$arch_dir: already present, skipping (set LLAMA_FORCE_REBUILD=1 to force)"
    return 0
  fi

  local build_dir="$WORK_DIR/build-$arch_dir"
  log "$arch_dir: configuring"
  local -a cfg=(
    -S "$SRC_DIR" -B "$build_dir"
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_SHARED_LIBS=OFF
    -DGGML_NATIVE=OFF
    -DLLAMA_BUILD_COMMON=ON
    -DLLAMA_BUILD_EXAMPLES=ON
    -DLLAMA_BUILD_TESTS=OFF
    -DLLAMA_BUILD_TOOLS=OFF
    -DLLAMA_BUILD_SERVER=OFF
    -DLLAMA_BUILD_APP=OFF
    -DLLAMA_BUILD_UI=OFF
    # Network-free: force OpenSSL OFF. `common` (needed by the example) ALWAYS links
    # cpp-httplib, which at this pinned commit compiles WITH OpenSSL HTTPS support
    # whenever CMake's LLAMA_OPENSSL (default ON) finds a host OpenSSL — baking
    # _SSL_get_error/_X509_*/_ERR_* into httplib.cpp.o and linking libssl/libcrypto.
    # On the arm64 macOS runner that host OpenSSL is arm64-only, so the x86_64
    # cross-link can't resolve those symbols → the mac-x64 leg fails to link. The
    # embedder never downloads (reads a LOCAL `-m` GGUF; Kawsay does its own consent-
    # gated model fetch), so OFF links ZERO TLS/HTTP/curl code (AC-4 zero-egress) AND
    # unblocks the x64 cross-link. LLAMA_CURL is deprecated/ignored at this pin —
    # LLAMA_OPENSSL is the real control for cpp-httplib's TLS.
    -DLLAMA_OPENSSL=OFF
  )
  if [ "$OS_KEY" = mac ]; then
    # CPU-only: force Metal OFF. llama.cpp defaults GGML_METAL=ON on Apple, and
    # compiling the Metal shader library for BOTH arm64 + x86_64 added ~60 min to
    # CI (vs ~3 min CPU-only, matching Windows). Metal is unnecessary here: the
    # embedder is multilingual-e5-small (tiny, 118M params) and embeddings are
    # produced by a background off-thread drain (not real-time), so CPU inference
    # is more than fast enough. Embeddings are backend-invariant for cosine
    # ranking, so a CPU build is equivalent to a Metal one. The CPU/Accelerate
    # (BLAS) backend stays on — only the GPU/Metal path is dropped.
    cfg+=(
      -DCMAKE_OSX_ARCHITECTURES="$osx_arch"
      -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
      -DGGML_METAL=OFF
    )
  elif [ "$OS_KEY" = win ]; then
    # Default VS generator is multi-config; pin the platform explicitly.
    cfg+=(-A x64)
  fi

  cmake "${cfg[@]}"

  log "$arch_dir: building llama-embedding (-j $JOBS)"
  cmake --build "$build_dir" --config Release --target llama-embedding -j "$JOBS"

  # Locate the binary across single-config (bin/) and multi-config (bin/Release/)
  # generator layouts; CMAKE_RUNTIME_OUTPUT_DIRECTORY is build/bin upstream.
  local bin
  bin="$(find "$build_dir/bin" -type f -name "llama-embedding$exe" 2>/dev/null | head -1 || true)"
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
