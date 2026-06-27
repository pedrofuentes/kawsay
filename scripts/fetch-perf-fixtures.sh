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
# guaranteed present; this avoids duplicating URLs/hashes in the script). Each
# field is validated to mirror the canonical zod schema in tests/perf/harness.ts
# BEFORE it is used — in particular `file` (and `id`) must be a bare basename so
# the `$DEST_DIR/$file` write below can never traverse out of the fixtures dir.
# Emits tab-separated url<TAB>file<TAB>sha256 lines; any unsafe field fails loud.
clips="$(node -e '
  const fs = require("fs");
  const BASENAME = /^[A-Za-z0-9._-]+$/;
  const SHA256 = /^[0-9a-f]{64}$/;
  const HTTPS = /^https:\/\/\S+$/;
  const die = (msg) => { console.error("::error::" + msg); process.exit(1); };
  let m;
  try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
  catch (e) { die("manifest is not valid JSON: " + e.message); }
  if (!m || !Array.isArray(m.clips) || m.clips.length === 0) die("manifest has no clips");
  for (const c of m.clips) {
    if (!c || typeof c !== "object") die("clip entry is not an object");
    if (typeof c.id !== "string" || !BASENAME.test(c.id)) die("unsafe clip id: " + JSON.stringify(c && c.id));
    if (typeof c.file !== "string" || !BASENAME.test(c.file)) die("unsafe clip file (must be a bare basename): " + JSON.stringify(c && c.file));
    if (typeof c.url !== "string" || !HTTPS.test(c.url)) die("clip url must be https: " + JSON.stringify(c && c.url));
    if (typeof c.sha256 !== "string" || !SHA256.test(c.sha256)) die("clip sha256 must be 64-char lowercase hex: " + JSON.stringify(c && c.sha256));
    process.stdout.write([c.url, c.file, c.sha256].join("\t") + "\n");
  }
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
