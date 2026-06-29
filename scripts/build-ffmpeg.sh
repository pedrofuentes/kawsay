#!/usr/bin/env bash
#
# build-ffmpeg.sh — compile LGPL-only ffmpeg + ffprobe from pinned FFmpeg source
# for both macOS arches, then stage them for electron-builder:
#
#     resources/media/mac-arm64/{ffmpeg,ffprobe}
#     resources/media/mac-x64/{ffmpeg,ffprobe}
#
# Windows keeps the clean @ffmpeg-installer/@ffprobe-installer prebuilts staged by
# scripts/stage-media-binaries.mjs. This script is Electron-free and shared by CI,
# release, and local use.
#
set -euo pipefail

FFMPEG_REPO="${FFMPEG_REPO:-FFmpeg/FFmpeg}"
FFMPEG_REF="${FFMPEG_REF:-n7.1}"
FFMPEG_COMMIT="${FFMPEG_COMMIT:-b08d7969c550a804a59511c7b83f2dd8cc0499b8}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_BASE="$REPO_ROOT/resources/media"
WORK_DIR="${FFMPEG_BUILD_DIR:-$REPO_ROOT/.ffmpeg-build}"
SRC_DIR="$WORK_DIR/src"

log() { printf '\n\033[1m[ffmpeg]\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m[ffmpeg] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

case "${RUNNER_OS:-$(uname -s)}" in
  macOS|Darwin) ;;
  *) die "Kawsay builds source ffmpeg only on macOS; Windows uses installer prebuilts." ;;
esac

command -v git >/dev/null 2>&1 || die "git not found on PATH"
command -v make >/dev/null 2>&1 || die "make not found on PATH"
command -v clang >/dev/null 2>&1 || die "clang not found on PATH"

if ! command -v nasm >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    log "Installing nasm with Homebrew"
    brew install nasm
  else
    die "nasm not found on PATH and Homebrew is unavailable"
  fi
fi

if [ ! -d "$SRC_DIR/.git" ]; then
  log "Cloning $FFMPEG_REPO @ $FFMPEG_REF (shallow)"
  rm -rf "$SRC_DIR"
  mkdir -p "$WORK_DIR"
  git clone --depth 1 --branch "$FFMPEG_REF" "https://github.com/$FFMPEG_REPO.git" "$SRC_DIR"
else
  log "Reusing existing checkout at $SRC_DIR"
fi

HEAD_SHA="$(git -C "$SRC_DIR" rev-parse HEAD)"
if [ "$HEAD_SHA" != "$FFMPEG_COMMIT" ]; then
  die "Pinned ref drift: $FFMPEG_REF resolved to $HEAD_SHA but expected $FFMPEG_COMMIT"
fi
log "Pinned commit verified: $HEAD_SHA"

license_text() {
  local bin="$1"
  "$bin" -L 2>&1 || true
}

assert_lgpl_clean() {
  local bin="$1" label="$2" runnable="$3"
  if strings "$bin" | grep -q -- '--enable-nonfree'; then
    die "$label buildconf contains --enable-nonfree"
  fi
  if [ "$runnable" = 1 ]; then
    local text
    text="$(license_text "$bin")"
    echo "$text" | grep -qi 'not legally redistributable' && die "$label is not legally redistributable"
    echo "$text" | grep -qi 'has nonfree parts' && die "$label reports nonfree parts"
    echo "$text" | grep -qi 'ffmpeg is free software' || die "$label -L did not report redistributable free software"
    log "$label license verified: $(echo "$text" | grep -i 'ffmpeg is free software' | head -1)"
  fi
}

verify_one() {
  local eb_arch="$1" osx_arch="$2" dest="$3" tool="$4"
  [ -s "$dest" ] || die "staged binary is empty: $dest"
  local archs
  archs="$(lipo -archs "$dest" 2>/dev/null || file -b "$dest" 2>/dev/null || true)"
  echo "$archs" | grep -q "$osx_arch" || die "expected $osx_arch $tool for $eb_arch, got: $archs"
  log "arch verified ($eb_arch/$tool): $archs"

  local runnable=0 host
  host="$(uname -m)"
  case "$host:$eb_arch" in
    arm64:arm64|x86_64:x64) runnable=1 ;;
  esac
  if [ "$tool" = ffmpeg ]; then
    assert_lgpl_clean "$dest" "$eb_arch/$tool" "$runnable"
  elif [ "$runnable" = 1 ]; then
    "$dest" -version >/dev/null 2>&1 || die "$eb_arch/$tool failed to launch"
  fi
}

build_one() {
  local eb_arch="$1" osx_arch="$2"
  local arch_dir="mac-$eb_arch"
  local dest_dir="$OUT_BASE/$arch_dir"
  local ffmpeg_dest="$dest_dir/ffmpeg"
  local ffprobe_dest="$dest_dir/ffprobe"

  if [ -f "$ffmpeg_dest" ] && [ -f "$ffprobe_dest" ] && [ -z "${FFMPEG_FORCE_REBUILD:-}" ]; then
    log "$arch_dir: already present, verifying (set FFMPEG_FORCE_REBUILD=1 to force)"
    verify_one "$eb_arch" "$osx_arch" "$ffmpeg_dest" ffmpeg
    verify_one "$eb_arch" "$osx_arch" "$ffprobe_dest" ffprobe
    return 0
  fi

  local build_dir="$WORK_DIR/build-$arch_dir"
  local install_dir="$WORK_DIR/install-$arch_dir"
  rm -rf "$build_dir" "$install_dir"
  mkdir -p "$build_dir" "$install_dir" "$dest_dir"

  log "$arch_dir: configuring LGPL static ffmpeg + ffprobe"
  pushd "$build_dir" >/dev/null
  local -a cfg=(
    "$SRC_DIR/configure"
    "--prefix=$install_dir"
    "--pkg-config-flags=--static"
    "--disable-shared"
    "--enable-static"
    "--disable-doc"
    "--disable-htmlpages"
    "--disable-manpages"
    "--disable-podpages"
    "--disable-txtpages"
    "--disable-ffplay"
    "--disable-debug"
    "--disable-gpl"
    "--disable-nonfree"
    "--disable-autodetect"
    "--enable-zlib"
    "--cc=clang"
    "--extra-cflags=-arch $osx_arch -mmacosx-version-min=11.0"
    "--extra-ldflags=-arch $osx_arch -mmacosx-version-min=11.0"
  )
  if [ "$eb_arch" = x64 ]; then
    cfg+=("--enable-cross-compile" "--target-os=darwin" "--arch=x86_64" "--cc=clang -arch x86_64")
  else
    cfg+=("--arch=arm64")
  fi
  "${cfg[@]}"

  log "$arch_dir: building ffmpeg + ffprobe"
  make -j"$(sysctl -n hw.ncpu)" ffmpeg ffprobe
  make install
  popd >/dev/null

  cp "$install_dir/bin/ffmpeg" "$ffmpeg_dest"
  cp "$install_dir/bin/ffprobe" "$ffprobe_dest"
  chmod +x "$ffmpeg_dest" "$ffprobe_dest"

  verify_one "$eb_arch" "$osx_arch" "$ffmpeg_dest" ffmpeg
  verify_one "$eb_arch" "$osx_arch" "$ffprobe_dest" ffprobe
  log "$arch_dir: staged at $dest_dir"
}

mkdir -p "$OUT_BASE"
build_one arm64 arm64
build_one x64 x86_64
log "done — staged ffmpeg + ffprobe under $OUT_BASE"
