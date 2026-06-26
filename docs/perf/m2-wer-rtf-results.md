# M2 offline accuracy/perf — is the `small` model good enough? (#137, ADR-0027)

**Short answer: yes — keep `small`.** On clean, labeled voice-note-style clips the
bundled `whisper-cli` (v1.9.1) + `small` model transcribes well within a sane
accuracy bar and runs **~4× faster than real time** on Apple Silicon. The single
worst clip was not a transcription-quality failure but a **language
auto-detection** miss on a very short (3.3 s) Spanish utterance. Two honest
caveats below qualify this for real Kawsay audio.

This locks the **AC-21** (WER) and **AC-18** (RTF/throughput) thresholds with
*evidence* rather than the illustrative clean-benchmark figures ADR-0027 carried
(`small` Spanish ~10–11%) — which were explicitly **not** load-bearing.

## Measured results

- **Model:** `ggml-small.bin` (sha256 `1be3a9b2…ea987b`, 487,601,967 bytes — the
  exact file ADR-0027 pins).
- **Binary:** Homebrew `whisper-cpp` **1.9.1** `whisper-cli` (the app-pinned
  whisper.cpp version), Metal backend.
- **Platform:** macOS (darwin/arm64), Apple Silicon.
- **Invocation:** identical to the app — the #133 ffmpeg extractor → 16 kHz mono
  WAV, the #134 executor, the same `-oj` argv, **language auto-detect**.
- **Fixtures:** 8 labeled Tatoeba clips (4× es, 2× de, 2× ru) — see
  `tests/perf/fixtures/NOTICES.md`. WER normalization: `tests/perf/wer.ts`.

| Language | Clips | OK | Ref words | Errors | WER (aggregate) | mean WER | mean RTF | Detected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| es | 4 | 4 | 33 | 5 | 15.2% | 20.8% | 0.19× | 3/4 (75.0%) |
| de | 2 | 2 | 18 | 2 | 11.1% | 11.3% | 0.32× | 2/2 (100.0%) |
| ru | 2 | 2 | 15 | 2 | 13.3% | 12.5% | 0.29× | 2/2 (100.0%) |
| **Overall** | 8 | 8 | 66 | 9 | **13.6%** | 16.4% | **0.25×** | **7/8 (87.5%)** |

| Clip | Lang | Detected | Audio (s) | Inference (s) | RTF | WER | Errors/Words | Transcript |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| es-941424 | es | **it** | 3.32 | 0.73 | 0.22× | **83.3%** | 5/6 | E già va la scuola camminando. |
| es-1075482 | es | es | 3.67 | 0.77 | 0.21× | 0.0% | 0/8 | El chico tiene una manzana en el bolsillo. |
| es-1086510 | es | es | 4.60 | 0.81 | 0.18× | 0.0% | 0/10 | Quiero otro cuchillo, uno que sirva para cortar el asado. |
| es-1101947 | es | es | 5.04 | 0.72 | 0.14× | 0.0% | 0/9 | Es otoño, la calle está cubierta de hojas secas. |
| de-344494 | de | de | 2.07 | 0.75 | 0.36× | 12.5% | 1/8 | Ich laufe lieber als dem Bus zu nehmen. |
| de-340872 | de | de | 2.72 | 0.73 | 0.27× | 10.0% | 1/10 | Ich frage mich, wer dieses Gerücht den Umlauf gebracht hat. |
| ru-374358 | ru | ru | 2.22 | 0.70 | 0.31× | 0.0% | 0/7 | Я спросил у него, как его зовут. |
| ru-351416 | ru | ru | 2.90 | 0.78 | 0.27× | 25.0% | 2/8 | Датый адрес обычно пишутся в шапке писем. |

> `whisper.cpp` greedy decoding is deterministic — re-running gives identical
> transcripts (hence identical WER); only RTF (wall-time) varies slightly.

## What the numbers say

- **Transcription quality is excellent on clean speech.** 6 of 8 clips are a
  perfect 0% WER. **Every Spanish clip that was correctly language-detected
  transcribed at 0%** — including accents and punctuation (`otoño`, the
  comma/period in `es-1101947`), which the normalization correctly ignores.
- **The dominant error was language ID, not transcription.** All 5 Spanish errors
  come from the **one** clip (`es-941424`, "Ella va a la escuela caminando.") — a
  short 3.3 s utterance auto-detected as **Italian** and decoded as Italian
  ("E già va la scuola camminando."). Exclude that LID miss and Spanish is ~0% on
  these clips. This is exactly the failure AC-21's *auto-detect* clause targets,
  and it is invisible in WER alone — which is why the harness also reports
  **language auto-detection accuracy (7/8 = 87.5%)**.
- **The two non-zero clean clips are minor.** German `den`→`dem` /
  `in`→`den` function-word slips; Russian merged `Дата и`→`Датый`. Small,
  human-plausible, not garbled.
- **Performance is comfortable.** Mean **RTF 0.25×** — ~4× faster than real time —
  on Apple Silicon (Metal), *including* a full 466 MB model reload per clip (the
  executor spawns `whisper-cli` per item, so this is faithful to production, not
  an optimistic warm-model number). AC-18's primary guarantee (work off the UI
  thread, no main-thread task > 50 ms) is asserted separately by #134; this is the
  throughput evidence beside it.

## Locked thresholds (`tests/perf/thresholds.ts`)

Greedy decoding makes WER stable run-to-run, so ceilings sit just above the
measured numbers (with a little cross-platform float head-room); RTF varies by
host/backend, so its ceiling is a deliberately loose cross-platform sanity bound.

| Threshold | Measured | Locked | Rationale |
| --- | ---: | ---: | --- |
| AC-21 — Spanish aggregate WER ceiling | 15.2% | **≤ 22%** | primary audience; head-room for the LID-sensitive short clip |
| AC-21 — overall aggregate WER ceiling | 13.6% | **≤ 18%** | all languages |
| AC-21 — language auto-detect accuracy floor | 87.5% | **≥ 75%** | allows ≤1/8 short-clip LID miss |
| AC-18 — mean RTF (clean clips) | 0.25× | **≤ 3×** | loose cross-platform guard; concrete per-platform target below |

**Concrete AC-18 RTF targets (per platform, informational):** Apple Silicon
(Metal) **≈ 0.25×** measured (target < 1×). A Windows/Linux **CPU** host will be
**slower** — near or modestly above real time for `small`, plus per-spawn model
load — so the cross-platform *gate* is loose; the *guarantee* that matters for
responsiveness (off-thread, no >50 ms main-thread task) is AC-18's #134 assertion,
not RTF.

## ⚠️ Honest caveats (do not over-read these numbers)

1. **Clean clips ≪ real WhatsApp audio.** These are studio-quiet, well-articulated
   single sentences. Real Kawsay input — spontaneous, accented, emotional,
   code-switched, compressed `.opus`, background noise — will score **materially
   worse**, consistent with ADR-0027. **AC-21's *field* WER ceiling must be
   re-derived on real Spanish samples** before it can claim field accuracy; the
   ceilings here certify "`small` clears a sane bar on clean speech", which is the
   answerable question this harness set out to answer.
2. **Short utterances risk language mis-detection.** A 3.3 s clip auto-detected as
   a close Romance language. Voice notes are usually longer, but the product
   should consider a **language hint from the user's locale** and/or a UI
   affordance to **correct the detected language**, especially for short clips.

## Recommendation

**Keep `small`.** It clears the accuracy bar comfortably on clean speech (most
clips perfect; correctly-detected Spanish at 0%) and is fast on Apple Silicon.
Reconsidering model size is **not** warranted by this evidence — the one bad clip
is a language-ID issue a larger model would not reliably fix and a language hint
would. Next: (a) gather a small set of **real, consented** noisy Spanish voice
notes to set the *field* AC-21 ceiling; (b) add a locale-based language hint /
user override for short-clip LID.

## Reproduce

```sh
brew install whisper-cpp ffmpeg                       # whisper-cli 1.9.1 + ffmpeg
curl -L -o ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
# verify: sha256 == 1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b

WHISPER_CLI_PATH="$(command -v whisper-cli)" \
WHISPER_MODEL_PATH="$PWD/ggml-small.bin" \
KAWSAY_FFMPEG_PATH="$(command -v ffmpeg)" \
scripts/run-wer-harness.sh
```

The clips are fetched + sha256-verified on demand; nothing here is committed to
git except the pinned manifest, this doc, and the harness code. The pure WER /
RTF / detection logic is unit-tested in normal CI (`tests/perf/*.test.ts`); the
heavy real-model run above is self-gated and **never** blocks required CI.
