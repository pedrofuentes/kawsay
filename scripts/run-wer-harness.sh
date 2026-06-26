#!/usr/bin/env bash
# Local-only driver for the M2 offline WER/RTF measurement (#137, ADR-0027):
# fetch the labeled clips, then run the GATED integration test against a real
# whisper-cli + `small` model and print the measured per-language WER + RTF table
# (the real answer to "is `small` good enough?"). This is NEVER run in CI — CI has
# neither the 466 MB model nor the per-arch binary, and the integration test
# self-skips without them. Mirrors the self-gated real-whisper convention.
#
# Required env:
#   WHISPER_CLI_PATH    absolute path to a whisper.cpp `whisper-cli` (v1.9.1)
#   WHISPER_MODEL_PATH  absolute path to a verified `ggml-small.bin`
# Optional env:
#   KAWSAY_FFMPEG_PATH       ffmpeg binary to decode the clips (else ffmpeg-static)
#   KAWSAY_PERF_FIXTURE_DIR  where the clips live (default: .perf-fixtures)
#   KAWSAY_PERF_RESULTS_OUT  write the markdown results table here
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

: "${WHISPER_CLI_PATH:?set WHISPER_CLI_PATH to a real whisper-cli binary (e.g. \$(brew --prefix)/bin/whisper-cli)}"
: "${WHISPER_MODEL_PATH:?set WHISPER_MODEL_PATH to a real, sha256-verified ggml-small.bin}"

# Ensure the labeled clips are present + integrity-checked (idempotent).
"$SCRIPT_DIR/fetch-perf-fixtures.sh"

export KAWSAY_PERF_RESULTS_OUT="${KAWSAY_PERF_RESULTS_OUT:-$ROOT_DIR/.perf-fixtures/results.md}"
echo "running real whisper-cli WER/RTF measurement → results: $KAWSAY_PERF_RESULTS_OUT"
pnpm exec vitest run tests/perf/wer-rtf.integration.test.ts

echo
echo "===== measured WER / RTF ====="
cat "$KAWSAY_PERF_RESULTS_OUT"
