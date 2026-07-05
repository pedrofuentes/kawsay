import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  GAZETTEER_ASSET_FILENAME,
  GAZETTEER_RESOURCE_SUBDIR,
  GAZETTEER_SAMPLE_FILENAME,
  PLACE_SOURCE_KEY_PREFIX,
  createGazetteer,
  formatPlaceLabel,
  isGazetteerBundled,
  loadGazetteer,
  parseGazetteerNdjson,
  placeSourceKey,
  resolveGazetteerAssetPath,
  type GazetteerEntry,
} from '../../electron/main/categorize/gazetteer';
import { haversineDistanceMeters, type GeoCoord } from '../../electron/main/categorize/places-cluster';

// A hand-authored in-memory gazetteer. The reverse-geocoder is fully injectable, so
// these unit tests NEVER touch the real bundled asset — they pass this fixture (or a
// small NDJSON string) directly, exactly the `semantic.ts` / `places-cluster.ts`
// discipline (pure input, deterministic output). Values are realistic GeoNames rows
// (id = geonameid; admin1/country = GeoNames codes) but the tests assert against
// exactly these, so nothing depends on the real dataset's contents.
const FIXTURE: readonly GazetteerEntry[] = [
  { id: 3936456, name: 'Lima', lat: -12.04318, lon: -77.02824, admin1: '15', country: 'PE' },
  { id: 3941584, name: 'Cusco', lat: -13.52264, lon: -71.96734, admin1: '08', country: 'PE' },
  { id: 2643743, name: 'London', lat: 51.50853, lon: -0.12574, admin1: 'ENG', country: 'GB' },
  { id: 5128581, name: 'New York City', lat: 40.71427, lon: -74.00597, admin1: 'NY', country: 'US' },
  { id: 1850147, name: 'Tokyo', lat: 35.6895, lon: 139.69171, admin1: '40', country: 'JP' },
  { id: 2988507, name: 'Paris', lat: 48.85341, lon: 2.3488, admin1: 'A8', country: 'FR' },
];

const gazetteerSourcePath = fileURLToPath(
  new URL('../../electron/main/categorize/gazetteer.ts', import.meta.url),
);
const gazetteerSource = readFileSync(gazetteerSourcePath, 'utf8');

const near = (lat: number, lon: number): GeoCoord => ({ lat, lon });

// A brute-force nearest — the ground truth the grid index must match. Reuses the
// SAME haversine as the module (imported from places-cluster), so a discrepancy is a
// grid bug, not a distance-metric difference.
function bruteForceNearest(
  entries: readonly GazetteerEntry[],
  query: GeoCoord,
): GazetteerEntry | null {
  let best: GazetteerEntry | null = null;
  let bestD = Infinity;
  for (const entry of entries) {
    const d = haversineDistanceMeters(query, entry);
    if (d < bestD) {
      bestD = d;
      best = entry;
    }
  }
  return best;
}

// A tiny deterministic LCG so the property test (grid == brute force) is reproducible.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('placeSourceKey + PLACE_SOURCE_KEY_PREFIX (namespacing)', () => {
  it('namespaces the geonameid under the "place:" prefix', () => {
    expect(PLACE_SOURCE_KEY_PREFIX).toBe('place:');
    expect(placeSourceKey(3941584)).toBe('place:3941584');
  });

  it('never collides with the theme source-key namespace', () => {
    // Themes use `theme:<sha256>` (ADR-0030 Decision 1). A place key must never be
    // mistakable for one, or a re-cluster upsert would clobber the wrong category.
    expect(placeSourceKey(1)).not.toMatch(/^theme:/);
    expect(placeSourceKey(1).startsWith('place:')).toBe(true);
  });
});

describe('formatPlaceLabel ("City, Admin1, Country")', () => {
  it('joins name, admin1, and country with ", "', () => {
    expect(formatPlaceLabel(FIXTURE[1])).toBe('Cusco, 08, PE');
  });

  it('omits an empty admin1 (→ "City, Country")', () => {
    const noAdmin1: GazetteerEntry = {
      id: 99,
      name: 'Somewhere',
      lat: 0,
      lon: 0,
      admin1: '',
      country: 'XX',
    };
    expect(formatPlaceLabel(noAdmin1)).toBe('Somewhere, XX');
  });

  it('omits an empty country too (→ just the city)', () => {
    const bare: GazetteerEntry = { id: 7, name: 'Lonelyville', lat: 0, lon: 0, admin1: '', country: '' };
    expect(formatPlaceLabel(bare)).toBe('Lonelyville');
  });
});

describe('createGazetteer + reverseGeocode (nearest gazetteer entry)', () => {
  it('reports its loaded size', () => {
    expect(createGazetteer(FIXTURE).size).toBe(FIXTURE.length);
  });

  it('resolves a centroid to the NEAREST entry as { label, sourceKey }', () => {
    const gazetteer = createGazetteer(FIXTURE);
    // A point a few km from Cusco's catalogued coordinate.
    const result = gazetteer.reverseGeocode(near(-13.53, -71.97));
    expect(result).not.toBeNull();
    expect(result).toEqual({ label: 'Cusco, 08, PE', sourceKey: 'place:3941584' });
  });

  it('picks the closer of two candidates, and flips when the query moves', () => {
    const gazetteer = createGazetteer(FIXTURE);
    // Clearly nearer London than Paris.
    expect(gazetteer.reverseGeocode(near(51.4, -0.1))?.sourceKey).toBe('place:2643743');
    // Clearly nearer Paris than London.
    expect(gazetteer.reverseGeocode(near(48.9, 2.4))?.sourceKey).toBe('place:2988507');
  });

  it('handles a southern-hemisphere query (Lima vs Cusco)', () => {
    const gazetteer = createGazetteer(FIXTURE);
    expect(gazetteer.reverseGeocode(near(-12.05, -77.03))?.label).toBe('Lima, 15, PE');
  });

  it('matches a brute-force nearest across many random queries (grid index is correct)', () => {
    // A larger synthetic gazetteer spread across the globe, then many random probes;
    // the grid/geohash nearest MUST equal the linear-scan nearest for every one.
    const rng = makeRng(0x9e3779b1);
    const entries: GazetteerEntry[] = [];
    for (let i = 0; i < 500; i += 1) {
      entries.push({
        id: 100000 + i,
        name: `City${String(i)}`,
        lat: rng() * 170 - 85, // avoid the exact poles
        lon: rng() * 360 - 180,
        admin1: 'A',
        country: 'ZZ',
      });
    }
    const gazetteer = createGazetteer(entries);
    for (let q = 0; q < 200; q += 1) {
      const query = near(rng() * 170 - 85, rng() * 360 - 180);
      const expected = bruteForceNearest(entries, query);
      expect(expected).not.toBeNull();
      const got = gazetteer.reverseGeocode(query);
      expect(got?.sourceKey).toBe(placeSourceKey((expected as GazetteerEntry).id));
    }
  });

  it('finds the nearest even across the antimeridian (±180° longitude seam)', () => {
    const entries: GazetteerEntry[] = [
      { id: 1, name: 'EastEdge', lat: 0, lon: 179.9, admin1: 'A', country: 'ZZ' },
      { id: 2, name: 'WestEdge', lat: 0, lon: -179.9, admin1: 'A', country: 'ZZ' },
    ];
    const gazetteer = createGazetteer(entries);
    // Sitting on the seam at +179.95 is essentially equidistant, but a query at
    // -179.95 is nearer the WEST edge — a naive lon-diff (no wrap) would pick East.
    expect(gazetteer.reverseGeocode(near(0, -179.95))?.sourceKey).toBe('place:2');
    expect(gazetteer.reverseGeocode(near(0, 179.95))?.sourceKey).toBe('place:1');
  });

  it('returns null from an empty gazetteer (no entries) — graceful, no throw', () => {
    const empty = createGazetteer([]);
    expect(empty.size).toBe(0);
    expect(() => empty.reverseGeocode(near(0, 0))).not.toThrow();
    expect(empty.reverseGeocode(near(0, 0))).toBeNull();
  });
});

describe('parseGazetteerNdjson', () => {
  it('parses one entry per line', () => {
    const text = [
      '{"id":1,"name":"A","lat":1.5,"lon":2.5,"admin1":"X","country":"ZZ"}',
      '{"id":2,"name":"B","lat":-3.5,"lon":4.5,"admin1":"","country":"YY"}',
    ].join('\n');
    expect(parseGazetteerNdjson(text)).toEqual([
      { id: 1, name: 'A', lat: 1.5, lon: 2.5, admin1: 'X', country: 'ZZ' },
      { id: 2, name: 'B', lat: -3.5, lon: 4.5, admin1: '', country: 'YY' },
    ]);
  });

  it('skips blank lines and trailing whitespace', () => {
    const text = '\n  \n{"id":1,"name":"A","lat":0,"lon":0,"admin1":"X","country":"ZZ"}\n\n';
    expect(parseGazetteerNdjson(text)).toHaveLength(1);
  });

  it('skips malformed / incomplete lines rather than throwing (resilient)', () => {
    const text = [
      'not json at all',
      '{"id":1,"name":"A","lat":0,"lon":0,"admin1":"X","country":"ZZ"}',
      '{"id":2,"name":"B"}', // missing coordinates
      '{"id":"nope","name":"C","lat":0,"lon":0,"admin1":"X","country":"ZZ"}', // wrong id type
    ].join('\n');
    const entries = parseGazetteerNdjson(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(1);
  });
});

describe('resolveGazetteerAssetPath', () => {
  const PACKAGED = {
    isPackaged: true,
    resourcesPath: '/Applications/Kawsay.app/Contents/Resources',
    projectRoot: '/unused/in/packaged',
  };
  const DEV = {
    isPackaged: false,
    resourcesPath: '/unused/in/dev',
    projectRoot: '/repo',
  };

  it('prefers the full asset under resourcesPath/gazetteer when packaged', () => {
    const path = resolveGazetteerAssetPath({ ...PACKAGED, exists: () => true });
    // Build the expected path with the same OS-native `path.join` the module uses, so
    // the assertion holds on both POSIX (`/`) and Windows (`\`) — the components (dir +
    // subdir + full-asset filename) are still asserted exactly.
    expect(path).toBe(
      join(PACKAGED.resourcesPath, GAZETTEER_RESOURCE_SUBDIR, GAZETTEER_ASSET_FILENAME),
    );
  });

  it('falls back to the committed sample when the full asset is absent', () => {
    const path = resolveGazetteerAssetPath({
      ...PACKAGED,
      exists: (p) => p.endsWith(GAZETTEER_SAMPLE_FILENAME),
    });
    expect(path).toBe(
      join(PACKAGED.resourcesPath, GAZETTEER_RESOURCE_SUBDIR, GAZETTEER_SAMPLE_FILENAME),
    );
  });

  it('resolves under projectRoot/resources/gazetteer in dev', () => {
    const path = resolveGazetteerAssetPath({ ...DEV, exists: () => true });
    expect(path).toBe(
      join(DEV.projectRoot, 'resources', GAZETTEER_RESOURCE_SUBDIR, GAZETTEER_ASSET_FILENAME),
    );
  });

  it('returns null when neither the full asset nor the sample exists', () => {
    expect(resolveGazetteerAssetPath({ ...PACKAGED, exists: () => false })).toBeNull();
  });
});

describe('isGazetteerBundled (the build-time opt-in gate signal, #270)', () => {
  const PACKAGED = {
    isPackaged: true,
    resourcesPath: '/Applications/Kawsay.app/Contents/Resources',
    projectRoot: '/unused/in/packaged',
  };

  it('is TRUE when a bundled asset (full or sample) is present — reveal the opt-in UI', () => {
    expect(isGazetteerBundled({ ...PACKAGED, exists: () => true })).toBe(true);
    expect(
      isGazetteerBundled({ ...PACKAGED, exists: (p) => p.endsWith(GAZETTEER_SAMPLE_FILENAME) }),
    ).toBe(true);
  });

  it('is FALSE when neither asset is present — keep the opt-in UI hidden', () => {
    expect(isGazetteerBundled({ ...PACKAGED, exists: () => false })).toBe(false);
  });

  it('reads ONLY the asset presence — it never opens the network or parses bytes', () => {
    // A pure path-presence probe: it must not need a readFile seam at all.
    const calls: string[] = [];
    const result = isGazetteerBundled({
      ...PACKAGED,
      exists: (p) => {
        calls.push(p);
        return true;
      },
    });
    expect(result).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('loadGazetteer (asset loading + graceful degrade)', () => {
  const OPTIONS = {
    isPackaged: false,
    resourcesPath: '/unused',
    projectRoot: '/repo',
  };

  it('loads + parses an NDJSON asset through the injected readFile', () => {
    const text = [
      '{"id":1,"name":"A","lat":10,"lon":10,"admin1":"X","country":"ZZ"}',
      '{"id":2,"name":"B","lat":-10,"lon":-10,"admin1":"Y","country":"YY"}',
    ].join('\n');
    const readFile = vi.fn(() => text);
    const gazetteer = loadGazetteer({ ...OPTIONS, exists: () => true, readFile });
    expect(gazetteer.size).toBe(2);
    expect(gazetteer.reverseGeocode(near(9.9, 9.9))?.sourceKey).toBe('place:1');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('degrades to an empty gazetteer (→ null) when the asset is ABSENT — never throws', () => {
    const readFile = vi.fn(() => {
      throw new Error('readFile must not be called when the asset is absent');
    });
    let gazetteer!: ReturnType<typeof loadGazetteer>;
    expect(() => {
      gazetteer = loadGazetteer({ ...OPTIONS, exists: () => false, readFile });
    }).not.toThrow();
    expect(gazetteer.size).toBe(0);
    expect(gazetteer.reverseGeocode(near(0, 0))).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('degrades to empty (never throws) when reading the asset itself fails', () => {
    const readFile = vi.fn(() => {
      throw new Error('disk error');
    });
    let gazetteer!: ReturnType<typeof loadGazetteer>;
    expect(() => {
      gazetteer = loadGazetteer({ ...OPTIONS, exists: () => true, readFile });
    }).not.toThrow();
    expect(gazetteer.size).toBe(0);
    expect(gazetteer.reverseGeocode(near(0, 0))).toBeNull();
  });
});

describe('committed sample asset (resources/gazetteer/cities1000.sample.ndjson)', () => {
  // End-to-end through the real dev resolution path: the committed sample must be a
  // well-formed NDJSON the module loads offline, so a fresh checkout (no pack script
  // run) still reverse-geocodes. Asserts a couple of anchor cities kept stable in the
  // sample; the full ~150k asset is produced by scripts/pack-gazetteer.mjs at release.
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

  it('loads offline and reverse-geocodes well-known coordinates', () => {
    const gazetteer = loadGazetteer({
      isPackaged: false,
      resourcesPath: '/unused',
      projectRoot: repoRoot,
    });
    expect(gazetteer.size).toBeGreaterThan(10);
    // Near central Lima → the Lima sample row.
    const lima = gazetteer.reverseGeocode(near(-12.05, -77.03));
    expect(lima?.label).toContain('Lima');
    expect(lima?.sourceKey).toMatch(/^place:\d+$/);
    // Near central London → the London sample row.
    expect(gazetteer.reverseGeocode(near(51.5, -0.13))?.label).toContain('London');
  });
});

describe('zero network egress (AC-4 / AC-31) — structural guarantee', () => {
  // The gazetteer is a BUNDLED, offline dataset (ADR-0030 Decision 2): reverse-
  // geocoding must make NO request of any kind — no tile server, no Nominatim, no
  // fetch. This pins that at the source level: the module must not import or name any
  // network (or subprocess) API, so it CANNOT egress even by accident.
  it('imports no network transport module', () => {
    expect(gazetteerSource).not.toMatch(/node:(https?|net|dgram|tls|http2)\b/);
    expect(gazetteerSource).not.toMatch(/\brequire\(\s*['"](https?|net|dgram|tls|http2)['"]\s*\)/);
    expect(gazetteerSource).not.toMatch(/from\s+['"](https?|net|dgram|tls|http2)['"]/);
  });

  it('names no fetch / XMLHttpRequest / WebSocket / subprocess API', () => {
    expect(gazetteerSource).not.toMatch(/\bfetch\s*\(/);
    expect(gazetteerSource).not.toMatch(/\bXMLHttpRequest\b/);
    expect(gazetteerSource).not.toMatch(/\bWebSocket\b/);
    expect(gazetteerSource).not.toMatch(/\bchild_process\b/);
    expect(gazetteerSource).not.toMatch(/\bspawn\b|\bexec\b/);
  });

  it('reuses haversineDistanceMeters from places-cluster (does not reimplement it)', () => {
    expect(gazetteerSource).toMatch(
      /import\s*\{[^}]*haversineDistanceMeters[^}]*\}\s*from\s*['"]\.\/places-cluster['"]/,
    );
    // The haversine formula's signature op — absent here because we import it.
    expect(gazetteerSource).not.toMatch(/Math\.asin/);
  });
});

describe('gazetteer packaging contract (electron-builder.yml, arch-independent)', () => {
  // The asset is DATA, not a per-arch native binary, so it ships as ONE copy per
  // installer under resources/gazetteer/ — no ${os}-${arch} expansion (ADR-0030
  // Decision 2). A missing source dir is a build-time WARNING, not an error, so a
  // local `pnpm dist` still produces a running app that degrades places gracefully.
  const builderYml = readFileSync(
    fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)),
    'utf8',
  );

  it('bundles resources/gazetteer as an arch-independent extraResource', () => {
    expect(builderYml).toMatch(/from:\s*'?resources\/gazetteer\/'?/);
    expect(builderYml).toMatch(/to:\s*'?gazetteer\/'?/);
  });

  it('keeps the resolver sub-directory in lock-step with the extraResource `to:`', () => {
    expect(GAZETTEER_RESOURCE_SUBDIR).toBe('gazetteer');
  });

  it('does NOT expand the gazetteer per ${os}-${arch} (it is arch-independent data)', () => {
    const gazetteerBlock = builderYml
      .split('\n')
      .filter((line) => line.includes('gazetteer'))
      .join('\n');
    expect(gazetteerBlock).not.toContain('${os}');
    expect(gazetteerBlock).not.toContain('${arch}');
  });
});
