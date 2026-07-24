// Guards the committed AC-32 photo fixtures (#510): three tiny EXIF-GPS JPEGs the
// hermetic categorization e2e journey imports to produce a deterministic "Shanghai"
// place suggestion offline. If a fixture is corrupted or regenerated with the wrong
// coordinates, this fails loudly here — through the app's REAL reader (`readExif`,
// exifr) — rather than mysteriously deep in the Playwright run. It also pins the
// premise the journey relies on: all three sit inside one place cluster (the
// clusterer's default eps=1500m / minPts=3), near the Shanghai gazetteer entry.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readExif } from '../../electron/main/importers/deps/exif';

const FIXTURE_DIR = fileURLToPath(new URL('../e2e/fixtures/photos-shanghai', import.meta.url));

/** The Shanghai gazetteer centroid the fixtures cluster around
 *  (resources/gazetteer/cities1000.sample.ndjson, id 1796236). */
const SHANGHAI = { lat: 31.22222, lon: 121.45806 };

const FIXTURES = [
  { file: 'shanghai-bund-1.jpg', lat: 31.22222, lon: 121.45806 },
  { file: 'shanghai-bund-2.jpg', lat: 31.2235, lon: 121.4595 },
  { file: 'shanghai-bund-3.jpg', lat: 31.221, lon: 121.457 },
] as const;

/** Great-circle distance in metres (haversine). */
function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe('AC-32 GPS photo fixtures (#510)', () => {
  it.each(FIXTURES)('$file exposes its EXIF GPS through the real reader', async ({
    file,
    lat,
    lon,
  }) => {
    const data = await readExif(join(FIXTURE_DIR, file));
    const gps = data?.gps;
    expect(gps).toBeDefined();
    if (gps === undefined) return; // narrowing for the assertions below
    expect(gps.lat).toBeCloseTo(lat, 3);
    expect(gps.lon).toBeCloseTo(lon, 3);
  });

  it('places all three inside one 1500 m place cluster around Shanghai', async () => {
    for (const { file } of FIXTURES) {
      const data = await readExif(join(FIXTURE_DIR, file));
      const gps = data?.gps;
      expect(gps).toBeDefined();
      if (gps === undefined) continue;
      // eps default is 1500 m; staying well inside it keeps the single-cluster,
      // minPts=3 premise robust to minor coordinate edits.
      expect(metresBetween(SHANGHAI, gps)).toBeLessThan(1500);
    }
  });
});
