#!/usr/bin/env bash
#
# convert-embed-model.sh — convert the M4 embedder model
# (intfloat/multilingual-e5-small, MIT) into the Q4_K_M GGUF the consent-download
# flow targets, and PROVE it was tokenized correctly. The produced artifact is the
# integrity-pinned Kawsay Release asset that electron/main/search/embed-model-source.ts
# points at (EMBED_MODEL_FILE_NAME). NOTHING here publishes — the maintainer-gated
# .github/workflows/publish-embed-model.yml runs this, then uploads the GGUF (§9 T4).
#
# ── The one non-obvious correctness requirement (from the M4-0 spike) ─────────────
# multilingual-e5-small's config.json declares `architectures: ["BertModel"]` but the
# model actually uses an XLM-RoBERTa **SentencePiece** tokenizer (tokenizer_class ==
# "XLMRobertaTokenizer", a root `sentencepiece.bpe.model`). llama.cpp's default
# BertModel.set_vocab picks the **WordPiece** path, which mis-tokenizes this lineage
# and yields collapsed/garbage embeddings (this is why community `-small` GGUFs are
# broken). We therefore PATCH BertModel.set_vocab at conversion time to route to the
# SentencePiece vocab path (`_xlmroberta_set_vocab`, which emits
# `tokenizer.ggml.model = t5`) WITHOUT calling `_xlmroberta_tokenizer_init` — these
# are true BERT models with ABSOLUTE position embeddings, so the RoBERTa pad-offset
# chop must NOT be applied. We patch the pinned upstream in place (NO vendored fork)
# and then HARD-ASSERT `tokenizer.ggml.model == t5` on the output: a wrong tokenizer
# is a broken product, so the build fails loudly rather than shipping garbage.
#
# ── Pins (single source of truth; overridable by CI env) ──────────────────────────
#   * llama.cpp is pinned to the SAME immutable commit as scripts/build-embed-cli.sh
#     (b9848 / 931eb37…). That one checkout provides BOTH convert_hf_to_gguf.py (with
#     the `conversion/` package that defines BertModel) AND llama-quantize.
#   * The model is pinned to an immutable HF revision so the produced bytes — and thus
#     the SHA-256 the descriptor will pin — are reproducible.
#
# Prereqs: a Python env with llama.cpp's convert deps installed
# (requirements/requirements-convert_hf_to_gguf.txt → torch, transformers,
# sentencepiece, gguf, protobuf, numpy) plus huggingface_hub; and cmake + git to build
# llama-quantize. The publish workflow provisions all of these.
#
set -euo pipefail

# --- pinned sources of truth (overridable by CI for a single pin location) --------
LLAMA_CPP_REPO="${LLAMA_CPP_REPO:-ggml-org/llama.cpp}"
LLAMA_CPP_REF="${LLAMA_CPP_REF:-b9848}"
LLAMA_CPP_COMMIT="${LLAMA_CPP_COMMIT:-931eb37f8cac5a6ca84d5641445d460af2a9d7dd}"

# The upstream, MIT-licensed embedder. Pinned to an immutable revision (not `main`)
# so re-running the conversion is byte-reproducible and the SHA-256 stays stable.
EMBED_MODEL_REPO="${EMBED_MODEL_REPO:-intfloat/multilingual-e5-small}"
EMBED_MODEL_REVISION="${EMBED_MODEL_REVISION:-614241f622f53c4eeff9890bdc4f31cfecc418b3}"

# Q4_K_M matches the descriptor's EMBED_MODEL_FILE_NAME (…-q4_k_m.gguf).
EMBED_MODEL_QUANT="${EMBED_MODEL_QUANT:-Q4_K_M}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/.embed-model-build}"
WORK_DIR="${EMBED_CONVERT_WORK_DIR:-$OUT_DIR/work}"
# MUST equal EMBED_MODEL_FILE_NAME in electron/main/search/embed-model-source.ts.
EMBED_MODEL_OUT_NAME="${EMBED_MODEL_OUT_NAME:-multilingual-e5-small-q4_k_m.gguf}"

MODEL_DIR="$WORK_DIR/model"
F16_GGUF="$WORK_DIR/multilingual-e5-small-f16.gguf"
OUT_GGUF="$OUT_DIR/$EMBED_MODEL_OUT_NAME"
META_OUT="$OUT_GGUF.metadata"

log() { printf '\n\033[1m[convert-embed]\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m[convert-embed] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git    >/dev/null 2>&1 || die "git not found on PATH"
command -v cmake  >/dev/null 2>&1 || die "cmake not found on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH"

mkdir -p "$OUT_DIR" "$WORK_DIR"

# --- 1. resolve + verify the immutable llama.cpp pin ------------------------------
# Reuse a caller-provided checkout (CI passes the one it already set up) or clone the
# pinned ref. EITHER WAY the HEAD is asserted to equal LLAMA_CPP_COMMIT, so a
# re-pointed/deleted upstream tag fails loudly instead of converting unexpected source.
if [ -n "${LLAMA_CPP_DIR:-}" ] && [ -d "${LLAMA_CPP_DIR:-}/.git" ]; then
  SRC_DIR="$LLAMA_CPP_DIR"
  log "Reusing provided llama.cpp checkout at $SRC_DIR"
else
  SRC_DIR="$WORK_DIR/llama.cpp"
  if [ ! -d "$SRC_DIR/.git" ]; then
    log "Cloning $LLAMA_CPP_REPO @ $LLAMA_CPP_REF (shallow)"
    rm -rf "$SRC_DIR"
    git clone --depth 1 --branch "$LLAMA_CPP_REF" \
      "https://github.com/$LLAMA_CPP_REPO.git" "$SRC_DIR"
  else
    log "Reusing existing checkout at $SRC_DIR"
  fi
fi

HEAD_SHA="$(git -C "$SRC_DIR" rev-parse HEAD)"
if [ "$HEAD_SHA" != "$LLAMA_CPP_COMMIT" ]; then
  die "Pinned ref drift: $SRC_DIR HEAD is $HEAD_SHA but expected $LLAMA_CPP_COMMIT"
fi
log "Pinned llama.cpp commit verified: $HEAD_SHA"

CONVERT_PY="$SRC_DIR/convert_hf_to_gguf.py"
[ -f "$CONVERT_PY" ] || die "convert_hf_to_gguf.py not found in $SRC_DIR (pin drift?)"

# --- 2. patch BertModel.set_vocab → SentencePiece (t5) path -----------------------
# At the pinned commit the converter lives in the `conversion/` package, so BertModel
# is in conversion/bert.py (older monolithic layouts kept it in convert_hf_to_gguf.py
# — we try both). We insert a guard at the TOP of BertModel.set_vocab that routes the
# multilingual-e5 lineage to the SentencePiece path. Anchored on the exact WordPiece
# first body line so we patch BertModel (NOT RobertaModel, which overrides set_vocab),
# validated to stay syntactically valid, idempotent, and FATAL if the anchor is gone.
log "Patching BertModel.set_vocab for the SentencePiece (t5) tokenizer"
KAWSAY_LLAMA_DIR="$SRC_DIR" python3 - <<'PY'
import ast
import os
import sys
from pathlib import Path

llama_dir = Path(os.environ["KAWSAY_LLAMA_DIR"])
MARKER = "KAWSAY-PATCH: multilingual-e5 SentencePiece vocab"

# The exact WordPiece signature of BertModel.set_vocab at the pin. Anchoring on the
# first body line keeps us off RobertaModel.set_vocab (docstring) / DistilBert (none).
ANCHOR = (
    "    def set_vocab(self):\n"
    "        tokens, toktypes, tokpre = self.get_vocab_base()\n"
)
GUARD = (
    "    def set_vocab(self):\n"
    "        # KAWSAY-PATCH: multilingual-e5 SentencePiece vocab (tokenizer.ggml.model = t5).\n"
    "        # multilingual-e5 / Multilingual-MiniLM lineage: BERT arch but an XLM-RoBERTa\n"
    "        # SentencePiece tokenizer. The default WordPiece path mis-tokenizes these\n"
    "        # (collapsing embeddings). Use the SentencePiece vocab path (tokenizer.ggml.model = t5).\n"
    "        # Do NOT call _xlmroberta_tokenizer_init: these are true BERT models with absolute\n"
    "        # position embeddings (no RoBERTa pad-offset), so positions must not be chopped.\n"
    "        if (self.dir_model / 'sentencepiece.bpe.model').is_file() and \\\n"
    "                self.hparams.get(\"tokenizer_class\") == \"XLMRobertaTokenizer\":\n"
    "            self._xlmroberta_set_vocab()\n"
    "            self.vocab_size = self.hparams.get(\"vocab_size\")\n"
    "            return\n"
    "        tokens, toktypes, tokpre = self.get_vocab_base()\n"
)

candidates = [llama_dir / "conversion" / "bert.py", llama_dir / "convert_hf_to_gguf.py"]
for path in candidates:
    if not path.is_file():
        continue
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"[convert-embed] SentencePiece patch already present in {path}")
        sys.exit(0)
    if ANCHOR not in text:
        continue
    if "_xlmroberta_set_vocab" not in text:
        sys.exit(
            f"[convert-embed] FATAL: {path} defines BertModel.set_vocab but not "
            "_xlmroberta_set_vocab — llama.cpp pin drift. Refusing to convert."
        )
    patched = text.replace(ANCHOR, GUARD, 1)
    ast.parse(patched)  # never write a syntactically broken converter
    path.write_text(patched, encoding="utf-8")
    print(f"[convert-embed] applied SentencePiece vocab patch to {path}")
    sys.exit(0)

sys.exit(
    "[convert-embed] FATAL: could not locate the BertModel.set_vocab WordPiece anchor "
    "to patch (llama.cpp pin drift?). Refusing to convert — the default path would "
    "produce broken WordPiece embeddings."
)
PY

# --- 3. download the pinned, MIT model (safetensors only, no onnx/openvino) -------
# Public, ungated repo → NO token required. allow_patterns keeps it to just what the
# converter reads (and crucially sentencepiece.bpe.model, which the t5 guard requires
# — a --remote conversion would NOT fetch it and would silently fall back to WordPiece).
log "Downloading $EMBED_MODEL_REPO @ $EMBED_MODEL_REVISION (safetensors)"
EMBED_MODEL_REPO="$EMBED_MODEL_REPO" \
EMBED_MODEL_REVISION="$EMBED_MODEL_REVISION" \
MODEL_DIR="$MODEL_DIR" python3 - <<'PY'
import os
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id=os.environ["EMBED_MODEL_REPO"],
    revision=os.environ["EMBED_MODEL_REVISION"],
    local_dir=os.environ["MODEL_DIR"],
    allow_patterns=[
        "config.json",
        "model.safetensors",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "sentencepiece.bpe.model",
    ],
)
print("[convert-embed] model downloaded to", os.environ["MODEL_DIR"])
PY

for f in config.json model.safetensors sentencepiece.bpe.model tokenizer_config.json; do
  [ -s "$MODEL_DIR/$f" ] || die "expected model file missing/empty: $f"
done
grep -q '"XLMRobertaTokenizer"' "$MODEL_DIR/tokenizer_config.json" \
  || die "tokenizer_config.json is not XLMRobertaTokenizer — the t5 guard would not fire"

# --- 4. convert to an f16 GGUF ----------------------------------------------------
log "Converting to f16 GGUF"
rm -f "$F16_GGUF"
python3 "$CONVERT_PY" "$MODEL_DIR" --outtype f16 --outfile "$F16_GGUF"
[ -s "$F16_GGUF" ] || die "f16 conversion produced no output"

# --- 5. build llama-quantize from the SAME pinned source --------------------------
# Reuse a caller-provided binary, else compile just the llama-quantize target
# (tools ON; examples/server/tests OFF; network-free — no TLS/curl link needed).
if [ -n "${LLAMA_QUANTIZE_BIN:-}" ] && [ -x "${LLAMA_QUANTIZE_BIN:-}" ]; then
  QUANTIZE_BIN="$LLAMA_QUANTIZE_BIN"
  log "Reusing provided llama-quantize: $QUANTIZE_BIN"
else
  if command -v nproc >/dev/null 2>&1; then
    JOBS="$(nproc)"
  elif command -v sysctl >/dev/null 2>&1; then
    JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  else
    JOBS="${NUMBER_OF_PROCESSORS:-4}"
  fi
  case "$JOBS" in ''|*[!0-9]*) JOBS=4 ;; esac
  [ "$JOBS" -ge 1 ] || JOBS=4

  QBUILD="$WORK_DIR/build-quantize"
  log "Building llama-quantize (-j $JOBS)"
  cmake -S "$SRC_DIR" -B "$QBUILD" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    -DLLAMA_BUILD_COMMON=ON \
    -DLLAMA_BUILD_TOOLS=ON \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_SERVER=OFF \
    -DLLAMA_BUILD_APP=OFF \
    -DLLAMA_BUILD_UI=OFF \
    -DLLAMA_OPENSSL=OFF \
    -DLLAMA_CURL=OFF
  cmake --build "$QBUILD" --config Release --target llama-quantize -j "$JOBS"
  QUANTIZE_BIN="$(find "$QBUILD/bin" -type f -name 'llama-quantize*' 2>/dev/null | head -1 || true)"
  [ -n "$QUANTIZE_BIN" ] || die "llama-quantize not found under $QBUILD/bin after build"
fi

# --- 6. quantize f16 → Q4_K_M -----------------------------------------------------
log "Quantizing → $EMBED_MODEL_QUANT"
rm -f "$OUT_GGUF"
"$QUANTIZE_BIN" "$F16_GGUF" "$OUT_GGUF" "$EMBED_MODEL_QUANT"
[ -s "$OUT_GGUF" ] || die "quantization produced no output"

# --- 7. HARD-ASSERT the tokenizer + arch, then emit SHA-256 + byte size -----------
# The whole point of the patch: a wrong tokenizer.ggml.model means broken embeddings,
# so refuse to emit the descriptor facts unless it is exactly `t5`. Use the pinned
# checkout's gguf-py reader (guarantees the metadata API used below).
log "Verifying tokenizer.ggml.model == t5 and computing SHA-256 + size"
OUT_GGUF="$OUT_GGUF" META_OUT="$META_OUT" \
PYTHONPATH="$SRC_DIR/gguf-py${PYTHONPATH:+:$PYTHONPATH}" python3 - <<'PY'
import hashlib
import os
import sys
from gguf import GGUFReader

path = os.environ["OUT_GGUF"]
reader = GGUFReader(path)


def field_str(key):
    field = reader.get_field(key)
    if field is None:
        return None
    return field.contents()


tokenizer = field_str("tokenizer.ggml.model")
arch = field_str("general.architecture")

if tokenizer != "t5":
    sys.exit(
        f"[convert-embed] FATAL: tokenizer.ggml.model == {tokenizer!r}, expected 't5'. "
        "The SentencePiece patch did not take (WordPiece → collapsed embeddings). "
        "Refusing to publish a broken model."
    )
if arch != "bert":
    sys.exit(f"[convert-embed] FATAL: general.architecture == {arch!r}, expected 'bert'.")

size = os.path.getsize(path)
digest = hashlib.sha256()
with open(path, "rb") as fh:
    for chunk in iter(lambda: fh.read(1 << 20), b""):
        digest.update(chunk)
sha256 = digest.hexdigest()

lines = [
    f"EMBED_MODEL_TOKENIZER={tokenizer}",
    f"EMBED_MODEL_ARCH={arch}",
    f"EMBED_MODEL_SHA256={sha256}",
    f"EMBED_MODEL_SIZE_BYTES={size}",
]
for line in lines:
    print(line)
with open(os.environ["META_OUT"], "w", encoding="utf-8") as out:
    out.write("\n".join(lines) + "\n")
PY

log "done — GGUF at $OUT_GGUF"
log "metadata (SHA-256 + size for the descriptor) at $META_OUT"
cat "$META_OUT"
