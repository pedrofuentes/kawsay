#!/usr/bin/env bash
# Fetch the labeled voice-note-style clips the M2 offline accuracy/perf harness
# (#137, ADR-0027) measures the real whisper-cli + `small` model against. The
# clips are short, license-clean Tatoeba recordings (Spanish + German + Russian);
# they are deliberately NOT committed to git — only tests/perf/fixtures/manifest.json
# (pinned URLs + SHA-256 + ground-truth labels) and NOTICES.md are. Each clip is
# pinned by sha256, so a changed or poisoned download fails this script loudly
# rather than letting the harness score against an unexpected input. Idempotent: a
# present, sha-matching file is left untouched. Mirrors scripts/fetch-egress-fixtures.sh.
# Portable across macOS + Windows(git-bash). TEST/DEV-ONLY — never run by the app.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${KAWSAY_PERF_MANIFEST:-$SCRIPT_DIR/../tests/perf/fixtures/manifest.json}"
DEST_DIR="${1:-${KAWSAY_PERF_FIXTURE_DIR:-.perf-fixtures}}"

if [ ! -f "$MANIFEST" ]; then
  echo "::error::manifest not found: $MANIFEST" >&2
  exit 1
fi

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
    rm -f "$dest"
    exit 1
  fi
  echo "ok (verified): $dest"
}

mkdir -p "$DEST_DIR"

# Single-source the clip list from the manifest (node is the project toolchain,
# guaranteed present; this avoids duplicating URLs/hashes in the script). Emits
# tab-separated url<TAB>file<TAB>sha256 lines.
clips="$(node -e '
  const m = require(process.argv[1]);
  for (const c of m.clips) process.stdout.write([c.url, c.file, c.sha256].join("\t") + "\n");
' "$MANIFEST")"

count=0
while IFS="$(printf "\t")" read -r url file want; do
  [ -z "$url" ] && continue
  fetch "$url" "$DEST_DIR/$file" "$want"
  count=$((count + 1))
done <<EOF
$clips
EOF

echo "$count perf fixture(s) ready in $DEST_DIR"
