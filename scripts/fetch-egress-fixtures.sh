#!/usr/bin/env bash
# Fetch the deterministic fixtures the AC-4 OS-deny harness runs the REAL
# whisper-cli against (ADR-0027 / #138): JFK's ~11s sample WAV (pinned to the
# whisper.cpp commit we build) and the tiny ggml model. Both are pinned by
# sha256, so a changed or poisoned download fails the job loudly rather than
# letting the harness transcribe an unexpected input. A TINY model is used
# deliberately — egress behaviour is model-size-independent (the shipped model is
# `small`, see model-source.ts) and a small fixture keeps CI fast. Idempotent: a
# present, sha-matching file is left untouched so an actions/cache hit skips the
# download. Portable across the macOS + Windows(git-bash) runners. TEST-ONLY.
set -euo pipefail

DEST_DIR="${1:-${KAWSAY_AC4_FIXTURE_DIR:-.harness-fixtures}}"

# Pinned to the same whisper.cpp commit scripts/build-whisper-cli.sh builds, so
# the sample matches the binary's vintage. Overridable for a coordinated bump.
WHISPER_CPP_COMMIT="${WHISPER_CPP_COMMIT:-f049fff95a089aa9969deb009cdd4892b3e74916}"
JFK_URL="https://raw.githubusercontent.com/ggml-org/whisper.cpp/${WHISPER_CPP_COMMIT}/samples/jfk.wav"
JFK_SHA256="59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
MODEL_SHA256="be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

fetch() {
  local url="$1" dest="$2" want="$3"
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$want" ]; then
    echo "ok (cached): $dest"
    return
  fi
  echo "downloading $url"
  curl --fail --silent --show-error --location --retry 3 --output "$dest" "$url"
  local got
  got="$(sha256_of "$dest")"
  if [ "$got" != "$want" ]; then
    echo "::error::sha256 mismatch for $dest (want ${want}, got ${got})" >&2
    exit 1
  fi
  echo "ok (verified): $dest"
}

mkdir -p "$DEST_DIR"
fetch "$JFK_URL" "$DEST_DIR/jfk.wav" "$JFK_SHA256"
fetch "$MODEL_URL" "$DEST_DIR/ggml-tiny.bin" "$MODEL_SHA256"
echo "fixtures ready in $DEST_DIR"
