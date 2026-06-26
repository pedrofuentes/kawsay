# Perf/accuracy fixtures — provenance, license & attribution

These are the labeled, voice-note-style clips the **M2 offline accuracy/perf
harness** (issue #137, ADR-0027) measures the bundled `whisper-cli` + `small`
model against, to answer **"is `small` good enough?"** empirically (PRD **AC-21**
WER ceiling, **AC-18** performance).

**The audio is _not_ committed to git.** Only this notice + the pinned
`manifest.json` (URLs + SHA-256 + ground-truth labels) live in the repo. The
clips are fetched on demand and integrity-checked with `scripts/fetch-perf-fixtures.sh`
(curl `--fail` + SHA-256 verify, fail-closed — same pattern as
`scripts/fetch-egress-fixtures.sh`). This keeps the repo small and binary-free
while remaining fully reproducible.

## Source

All clips come from **[Tatoeba](https://tatoeba.org)**, a collection of sentences
and recorded translations. Each clip is one short, clearly-spoken sentence — a
deliberately **clean** proxy for a voice note. They are fetched from the canonical
audio host `https://audio.tatoeba.org/sentences/<lang3>/<id>.mp3`.

> ⚠️ **Honest caveat (carried into the results doc):** these are clean,
> studio-quiet, well-articulated single sentences. **Real Kawsay audio — noisy,
> accented, emotional WhatsApp voice notes — will score materially worse** than
> the WER measured here. Treat these numbers as a *best-case floor*, not a field
> estimate. See `docs/perf/m2-wer-rtf-results.md`.

## License

- **Sentence text:** © Tatoeba contributors, **CC BY 2.0 FR**
  (https://creativecommons.org/licenses/by/2.0/fr/).
- **Audio recordings:** licensed **per clip** by the individual recorder. Only
  permissive, redistributable licenses are included here — **CC BY 4.0** and
  **CC0 1.0**. Clips under any NonCommercial (NC) or NoDerivatives (ND) license
  were deliberately excluded.

Authoritative license/author for each clip was confirmed via the Tatoeba API
(`https://tatoeba.org/en/api_v0/sentence/<id>` → `audios[0].author` / `.license`).

## Per-clip attribution

| Clip id | Lang | Tatoeba sentence | Recorder | Audio license | Ground-truth transcript |
| --- | --- | --- | --- | --- | --- |
| es-941424  | es | [941424](https://tatoeba.org/en/sentences/show/941424)   | hayastan      | CC BY 4.0 | Ella va a la escuela caminando. |
| es-1075482 | es | [1075482](https://tatoeba.org/en/sentences/show/1075482) | hayastan      | CC BY 4.0 | El chico tiene una manzana en el bolsillo. |
| es-1086510 | es | [1086510](https://tatoeba.org/en/sentences/show/1086510) | hayastan      | CC BY 4.0 | Quiero otro cuchillo, uno que sirva para cortar el asado. |
| es-1101947 | es | [1101947](https://tatoeba.org/en/sentences/show/1101947) | hayastan      | CC BY 4.0 | Es otoño. La calle está cubierta de hojas secas. |
| de-344494  | de | [344494](https://tatoeba.org/en/sentences/show/344494)   | MisterTrouser | CC BY 4.0 | Ich laufe lieber, als den Bus zu nehmen. |
| de-340872  | de | [340872](https://tatoeba.org/en/sentences/show/340872)   | MisterTrouser | CC BY 4.0 | Ich frage mich, wer dieses Gerücht in Umlauf gebracht hat. |
| ru-374358  | ru | [374358](https://tatoeba.org/en/sentences/show/374358)   | retr0ra1n     | CC0 1.0   | Я спросил у него, как его зовут. |
| ru-351416  | ru | [351416](https://tatoeba.org/en/sentences/show/351416)   | retr0ra1n     | CC0 1.0   | Дата и адрес обычно пишутся в шапке писем. |

Languages: **Spanish** (es, primary — Kawsay's first audience), plus **German**
(de) and **Russian** (ru) to exercise multilingual auto-detection (Latin
diacritics + ß, and a non-Latin script). All eight clips total ~360 KB.

## WER normalization (the metric these labels assume)

WER is computed over text put through one documented normalization (see
`tests/perf/wer.ts`, unit-tested in `tests/perf/wer.test.ts`):

1. Unicode **NFC** normalization (composed ≡ decomposed accents);
2. **lowercase**;
3. replace every run of characters that are **not** a Unicode letter/number/space
   with a single space (so punctuation/symbols are dropped but **accents,
   umlauts, ß and Cyrillic are kept**);
4. **collapse** whitespace to single spaces and **trim**.

The score is then a standard `(substitutions + deletions + insertions) / reference_words`.

## How to fetch

```sh
scripts/fetch-perf-fixtures.sh                 # → .perf-fixtures/ (git-ignored)
KAWSAY_PERF_FIXTURE_DIR=/some/dir scripts/fetch-perf-fixtures.sh
```

Re-running is idempotent: a present, SHA-matching file is left untouched. A
changed or poisoned download fails the script loudly rather than measuring
against an unexpected input.
