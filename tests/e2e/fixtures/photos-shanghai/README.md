# photos-shanghai — GPS photo fixtures for the AC-32 e2e journey (#510)

Three tiny JPEGs carrying EXIF GPS tags clustered ~300 m apart, all within a few
hundred metres of the **Shanghai** entry in
`resources/gazetteer/cities1000.sample.ndjson` (id `1796236`, `31.22222,121.45806`).

Why three, and why here: the place clusterer defaults to `eps = 1500 m` and
`minPts = 3` (`electron/main/categorize/places-cluster.ts`), and the orchestrator
passes no override. Three GPS points inside one 1.5 km neighbourhood therefore form
exactly one cluster, which reverse-geocodes against the **committed sample
gazetteer** to a deterministic "Shanghai" place suggestion — with **no embedder
model and no network** (the theme path, which needs the 119 MB model, is
deliberately not exercised; AC-4 zero-egress holds).

| file | latitude | longitude |
|------|----------|-----------|
| `shanghai-bund-1.jpg` | 31.22222 | 121.45806 |
| `shanghai-bund-2.jpg` | 31.22350 | 121.45950 |
| `shanghai-bund-3.jpg` | 31.22100 | 121.45700 |

The pixels are irrelevant (a 48×48 solid colour) — only the EXIF GPS matters.
`tests/unit/gps-photo-fixtures.test.ts` pins that the app's real reader (`exifr`,
via `electron/main/importers/deps/exif.ts`) parses these coordinates, so a
corrupted or mis-regenerated fixture fails there loudly rather than mysteriously
in the e2e run.

## Regenerating

The generator is **out-of-band tooling, not a repo dependency** — Kawsay has no
EXIF *writer* (only `exifr`, a reader). Run it in a throwaway virtualenv and commit
only the resulting `.jpg` bytes:

```sh
python3 -m venv /tmp/exifvenv
/tmp/exifvenv/bin/pip install piexif Pillow
/tmp/exifvenv/bin/python scripts/generate-gps-fixtures.py tests/e2e/fixtures/photos-shanghai
```
