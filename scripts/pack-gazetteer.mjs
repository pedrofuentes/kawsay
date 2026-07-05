// Reproducible packer for the OFFLINE places gazetteer (ADR-0030 Decision 2,
// milestone M4-2d / #266). It downloads the GeoNames `cities1000` dump, trims it to
// the five fields Kawsay's reverse-geocoder needs (+ the geonameid key), and writes a
// compact NDJSON that electron/main/categorize/gazetteer.ts loads at runtime.
//
// DATA SOURCE & LICENSE
//   GeoNames `cities1000` — all cities with a population >= 1000 (and seats of admin
//   divisions), ~150k rows. https://download.geonames.org/export/dump/cities1000.zip
//   © GeoNames, licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
//   Redistributing it obliges attribution — see NOTICES.md and the in-app About line.
//   Kawsay keeps ONLY: geonameid, name, latitude, longitude, admin1 code, country
//   code; the ~13 other columns (asciiname, alternatenames, feature class/code, cc2,
//   admin2..4, population, elevation, dem, timezone, modification date) are dropped.
//
// USAGE (dev/release tooling only — NOT imported by the app or the test suite; run
// with a plain `node`, no build step, exactly like scripts/stage-media-binaries.mjs):
//
//   node scripts/pack-gazetteer.mjs
//       → downloads cities1000.zip and writes the FULL asset
//         resources/gazetteer/cities1000.ndjson (single-digit MB; gitignored, bundled
//         at package time by electron-builder — never committed).
//
//   node scripts/pack-gazetteer.mjs --sample[=N]
//       → writes the SMALL committed sample resources/gazetteer/cities1000.sample.ndjson
//         with the top-N (default 128) places by population — a representative,
//         offline default so a fresh checkout still reverse-geocodes. This is the
//         reproducible source of the committed sample.
//
// The two outputs share ONE trim/format path, so the sample is byte-for-byte a subset
// of the full asset's rows. Zero NEW dependencies: Node built-ins + the existing
// `yauzl` (already a dependency for the archive importers).

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

/** The canonical GeoNames dump (CC BY 4.0). */
export const CITIES1000_URL = 'https://download.geonames.org/export/dump/cities1000.zip';

/** The single text file packed inside cities1000.zip. */
const ZIP_ENTRY_NAME = 'cities1000.txt';

/** Default number of rows in the committed sample (top-N by population). */
const DEFAULT_SAMPLE_SIZE = 128;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const outputDir = join(repoRoot, 'resources', 'gazetteer');
const FULL_ASSET_PATH = join(outputDir, 'cities1000.ndjson');
const SAMPLE_ASSET_PATH = join(outputDir, 'cities1000.sample.ndjson');

// GeoNames cities1000.txt is tab-separated with a fixed, documented column order.
const COL_GEONAMEID = 0;
const COL_NAME = 1;
const COL_LATITUDE = 4;
const COL_LONGITUDE = 5;
const COL_COUNTRY_CODE = 8;
const COL_ADMIN1_CODE = 10;
const COL_POPULATION = 14;

/** Download a URL to a Buffer, following redirects. */
export function download(url) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`GET ${url} failed with HTTP ${String(status)}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

/** Extract the `cities1000.txt` payload from the zip Buffer as a string. */
export function readZipEntry(zipBuffer, entryName = ZIP_ENTRY_NAME) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new Error('yauzl returned no zipfile'));
        return;
      }
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            reject(streamErr ?? new Error(`cannot read ${entryName}`));
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => reject(new Error(`entry ${entryName} not found in archive`)));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

/**
 * Trim the raw TSV to the fields Kawsay keeps. Returns objects (population retained
 * transiently only to rank the sample); rows with an unparseable coordinate are
 * dropped. Deterministic: input order is preserved.
 */
export function trimRows(tsv) {
  const rows = [];
  for (const line of tsv.split('\n')) {
    if (line.length === 0) continue;
    const cols = line.split('\t');
    const id = Number.parseInt(cols[COL_GEONAMEID] ?? '', 10);
    const lat = Number.parseFloat(cols[COL_LATITUDE] ?? '');
    const lon = Number.parseFloat(cols[COL_LONGITUDE] ?? '');
    const name = cols[COL_NAME] ?? '';
    if (
      !Number.isFinite(id) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      name.length === 0
    ) {
      continue;
    }
    rows.push({
      id,
      name,
      lat,
      lon,
      admin1: cols[COL_ADMIN1_CODE] ?? '',
      country: cols[COL_COUNTRY_CODE] ?? '',
      population: Number.parseInt(cols[COL_POPULATION] ?? '', 10) || 0,
    });
  }
  return rows;
}

/** One compact NDJSON line per row (the exact shape gazetteer.ts parses). */
export function toNdjson(rows) {
  return (
    rows
      .map((row) =>
        JSON.stringify({
          id: row.id,
          name: row.name,
          lat: row.lat,
          lon: row.lon,
          admin1: row.admin1,
          country: row.country,
        }),
      )
      .join('\n') + '\n'
  );
}

/**
 * The top-`limit` rows by population, ties broken by ascending geonameid so the
 * committed sample is byte-stable across regenerations.
 */
export function topByPopulation(rows, limit) {
  return [...rows].sort((a, b) => b.population - a.population || a.id - b.id).slice(0, limit);
}

async function writeNdjson(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(path);
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.end(toNdjson(rows));
  });
}

function parseSampleSize(args) {
  const flag = args.find((arg) => arg === '--sample' || arg.startsWith('--sample='));
  if (flag === undefined) return null;
  const eq = flag.indexOf('=');
  if (eq === -1) return DEFAULT_SAMPLE_SIZE;
  const parsed = Number.parseInt(flag.slice(eq + 1), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_SIZE;
}

async function main() {
  const sampleSize = parseSampleSize(process.argv.slice(2));
  process.stdout.write(`Downloading ${CITIES1000_URL} ...\n`);
  const zipBuffer = await download(CITIES1000_URL);
  process.stdout.write(
    `Downloaded ${String(zipBuffer.length)} bytes; unpacking ${ZIP_ENTRY_NAME} ...\n`,
  );
  const tsv = await readZipEntry(zipBuffer);
  const rows = trimRows(tsv);
  process.stdout.write(`Trimmed ${String(rows.length)} places.\n`);

  if (sampleSize === null) {
    await writeNdjson(FULL_ASSET_PATH, rows);
    process.stdout.write(`Wrote FULL asset → ${FULL_ASSET_PATH} (${String(rows.length)} rows)\n`);
  } else {
    const sample = topByPopulation(rows, sampleSize);
    await writeNdjson(SAMPLE_ASSET_PATH, sample);
    process.stdout.write(`Wrote SAMPLE → ${SAMPLE_ASSET_PATH} (${String(sample.length)} rows)\n`);
  }
}

// Run only when invoked directly (its pure helpers are otherwise importable/testable).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `pack-gazetteer failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
