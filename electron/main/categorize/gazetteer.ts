import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { haversineDistanceMeters, type GeoCoord } from './places-cluster';

// Offline reverse-geocoder for the places pipeline (ADR-0030 Decision 2, milestone
// M4-2d). Given a GPS cluster centroid it returns the NEAREST populated place from a
// BUNDLED gazetteer (GeoNames cities1000, CC BY 4.0) as a "City, Admin1, Country"
// label plus a stable `place:<geonameid>` category source key.
//
// Zero egress is the whole point (AC-4 / AC-31, PRD §7 "no online maps"): this module
// makes NO request of any kind — no tile server, no Nominatim, no lookup service. The
// dataset is read once from a local file and every query is answered by a pure,
// in-memory nearest-neighbour search over a coarse degree-grid spatial index. The
// only distance metric is `haversineDistanceMeters`, REUSED from `places-cluster.ts`
// (never reimplemented), so the clustering and the reverse-geocode share one sphere.
//
// It mirrors the seams of its siblings: pure + deterministic like `semantic.ts` /
// `places-cluster.ts`, and fully injectable like `embed-cli.ts` — the asset path, the
// existence probe, and the file reader are all parameters, so unit tests pass a small
// in-memory fixture and never touch the real bundled asset. When the asset is absent
// (a fresh dev checkout with no pack-script run, or a `pnpm dist` that skipped it),
// loading degrades to an empty gazetteer whose `reverseGeocode` returns `null` — the
// "cluster-without-label" degrade of ADR-0030, never a throw.

/** Sub-directory (under the resources root) that holds the bundled gazetteer asset. */
export const GAZETTEER_RESOURCE_SUBDIR = 'gazetteer';

/** The full packed asset (produced at release time by `scripts/pack-gazetteer.mjs`). */
export const GAZETTEER_ASSET_FILENAME = 'cities1000.ndjson';

/** The small representative sample committed to git so a fresh checkout still works. */
export const GAZETTEER_SAMPLE_FILENAME = 'cities1000.sample.ndjson';

/**
 * Namespace prefix for a place category's `source_key` (ADR-0030 Decision 1). Keyed
 * on the GeoNames id (`place:<geonameid>`) so a re-cluster upserts the SAME category,
 * and so it can never collide with a theme key (`theme:<sha256>`).
 */
export const PLACE_SOURCE_KEY_PREFIX = 'place:';

/**
 * Degree size of one spatial-index cell. ~0.5° (~55 km of latitude) keeps a typical
 * near-a-city query scanning only a handful of buckets while the whole ~150k-row
 * asset still indexes into a bounded number of cells.
 */
const GAZETTEER_CELL_DEGREES = 0.5;

/**
 * Initial nearest-search radius. Populated places are dense in inhabited regions, so
 * the first bucketed scan almost always already contains the nearest place; a remote
 * centroid simply widens the radius until one appears (see {@link GazetteerGrid.nearest}).
 */
const GAZETTEER_INITIAL_SEARCH_METERS = 50_000;

/** Growth factor applied to the search radius each time a scan finds no candidate. */
const GAZETTEER_SEARCH_GROWTH = 4;

// These three search-tuning constants are intentionally kept in-source rather than
// externalized to config: retuning is a rebuild, which is acceptable for a fully-local
// app and keeps each value reviewable next to the rationale above (#333 — no action).

// IUGG mean Earth radius — the SAME sphere `places-cluster.ts` uses, so the grid's
// metre↔degree conversions are exactly consistent with the imported haversine metric.
const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_DEGREE_LAT = (Math.PI / 180) * EARTH_RADIUS_METERS;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * One gazetteer place. `id` is the GeoNames `geonameid` (→ the `place:<id>` source
 * key); `admin1`/`country` are GeoNames codes as shipped in the dataset (e.g. `15`,
 * `PE`). All other cities1000 columns are dropped at pack time.
 */
export interface GazetteerEntry {
  readonly id: number;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly admin1: string;
  readonly country: string;
}

/** The reverse-geocode of a centroid: a display label + the place category key. */
export interface ReverseGeocodeResult {
  /** Human-readable place label, `"City, Admin1, Country"` (empty parts omitted). */
  readonly label: string;
  /** The place category `source_key`, `place:<geonameid>`. */
  readonly sourceKey: string;
}

/** A loaded, queryable gazetteer. */
export interface Gazetteer {
  /** Number of loaded entries (0 ⇒ the asset was absent/unreadable — degrade). */
  readonly size: number;
  /**
   * The nearest place to `centroid`, or `null` when the gazetteer is empty (asset
   * absent). Never throws — a missing asset degrades places to no label.
   */
  reverseGeocode(centroid: GeoCoord): ReverseGeocodeResult | null;
}

/** The place category `source_key` for a GeoNames id, `place:<geonameid>`. */
export function placeSourceKey(geonameId: number): string {
  return `${PLACE_SOURCE_KEY_PREFIX}${String(geonameId)}`;
}

/**
 * Build the `"City, Admin1, Country"` label, omitting any empty component (some
 * cities1000 rows carry no admin1 code, yielding `"City, Country"`).
 */
export function formatPlaceLabel(entry: GazetteerEntry): string {
  return [entry.name, entry.admin1, entry.country].filter((part) => part.length > 0).join(', ');
}

// ── The degree-grid spatial index + nearest-neighbour search ────────────────

/** The nearest entry to `query` among a NON-EMPTY list (exact haversine). */
function nearestEntry(entries: readonly GazetteerEntry[], query: GeoCoord): GazetteerEntry {
  let best = entries[0];
  let bestMeters = haversineDistanceMeters(query, best);
  for (let i = 1; i < entries.length; i += 1) {
    const candidate = entries[i];
    const meters = haversineDistanceMeters(query, candidate);
    if (meters < bestMeters) {
      best = candidate;
      bestMeters = meters;
    }
  }
  return best;
}

/**
 * A coarse degree-grid bucket index over the gazetteer, mirroring the proven
 * `DegreeGrid` of `places-cluster.ts` (longitude cells wrap at the antimeridian; the
 * longitude span widens by 1/cos(lat) toward the poles), generalized from a fixed
 * `eps` neighbourhood to an arbitrary search radius so it answers nearest-neighbour.
 */
class GazetteerGrid {
  private readonly cellDeg: number;
  private readonly lonCellCount: number;
  private readonly cells = new Map<string, GazetteerEntry[]>();

  constructor(entries: readonly GazetteerEntry[], cellDeg: number) {
    this.cellDeg = cellDeg;
    this.lonCellCount = Math.max(1, Math.ceil(360 / cellDeg));
    for (const entry of entries) {
      const key = this.keyFor(entry.lat, entry.lon);
      const bucket = this.cells.get(key);
      if (bucket === undefined) this.cells.set(key, [entry]);
      else bucket.push(entry);
    }
  }

  private latCell(lat: number): number {
    return Math.floor(lat / this.cellDeg);
  }

  // Longitude wrapped into [0, lonCellCount) so the ±180° seam is contiguous.
  private lonCell(lon: number): number {
    const raw = Math.floor(lon / this.cellDeg);
    return ((raw % this.lonCellCount) + this.lonCellCount) % this.lonCellCount;
  }

  private keyFor(lat: number, lon: number): string {
    return `${String(this.latCell(lat))},${String(this.lonCell(lon))}`;
  }

  /**
   * Every entry within `radiusMeters` of `query` (exact haversine), found by scanning
   * only the bounded block of cells that could hold one. Returns a SUPERSET refined by
   * the exact check, so the result is precise.
   */
  private within(query: GeoCoord, radiusMeters: number): GazetteerEntry[] {
    const cellMeters = this.cellDeg * METERS_PER_DEGREE_LAT;
    const latSpan = Math.ceil(radiusMeters / cellMeters) + 1;
    // Longitude compresses by cos(lat): widen the span using the most poleward
    // latitude the block reaches, then a 1-cell safety margin.
    const worstLatDeg = Math.min(90, Math.abs(query.lat) + latSpan * this.cellDeg);
    const cosLat = Math.max(Math.cos(toRadians(worstLatDeg)), Number.EPSILON);
    const lonSpan = Math.ceil(radiusMeters / (cellMeters * cosLat)) + 1;

    const queryLatCell = this.latCell(query.lat);
    const queryLonCell = this.lonCell(query.lon);
    const found: GazetteerEntry[] = [];
    const scanCell = (latCell: number, lonCell: number): void => {
      const bucket = this.cells.get(`${String(latCell)},${String(lonCell)}`);
      if (bucket === undefined) return;
      for (const entry of bucket) {
        if (haversineDistanceMeters(query, entry) <= radiusMeters) found.push(entry);
      }
    };

    for (let dLat = -latSpan; dLat <= latSpan; dLat += 1) {
      const latCell = queryLatCell + dLat;
      if (2 * lonSpan + 1 >= this.lonCellCount) {
        // The span wraps the whole ring (only near the poles / at a very wide radius):
        // scan every longitude cell in this latitude row exactly once.
        for (let lonCell = 0; lonCell < this.lonCellCount; lonCell += 1) scanCell(latCell, lonCell);
      } else {
        for (let dLon = -lonSpan; dLon <= lonSpan; dLon += 1) {
          const lonCell =
            (((queryLonCell + dLon) % this.lonCellCount) + this.lonCellCount) % this.lonCellCount;
          scanCell(latCell, lonCell);
        }
      }
    }
    return found;
  }

  /**
   * The single nearest entry to `query`. Widen the radius geometrically until a scan
   * yields a candidate: the FIRST non-empty radius is guaranteed to contain the global
   * nearest, because every entry outside it is strictly farther than the radius (and
   * thus farther than the candidate already found within it). The caller only ever
   * builds a grid over a NON-EMPTY entry set, so some finite radius always succeeds.
   */
  nearest(query: GeoCoord): GazetteerEntry {
    let radiusMeters = GAZETTEER_INITIAL_SEARCH_METERS;
    for (;;) {
      const found = this.within(query, radiusMeters);
      if (found.length > 0) return nearestEntry(found, query);
      radiusMeters *= GAZETTEER_SEARCH_GROWTH;
    }
  }
}

/**
 * Build a queryable {@link Gazetteer} from in-memory entries (the unit-test seam). An
 * empty list yields a gazetteer whose `reverseGeocode` always returns `null`.
 */
export function createGazetteer(entries: readonly GazetteerEntry[]): Gazetteer {
  const grid = entries.length > 0 ? new GazetteerGrid(entries, GAZETTEER_CELL_DEGREES) : null;
  return {
    size: entries.length,
    reverseGeocode(centroid: GeoCoord): ReverseGeocodeResult | null {
      if (grid === null) return null;
      const entry = grid.nearest(centroid);
      return { label: formatPlaceLabel(entry), sourceKey: placeSourceKey(entry.id) };
    },
  };
}

// ── NDJSON parsing + asset loading ──────────────────────────────────────────

/** Narrow one parsed JSON value to a {@link GazetteerEntry}, or `null` if malformed. */
function toGazetteerEntry(value: unknown): GazetteerEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'number' || !Number.isFinite(row.id)) return null;
  if (typeof row.name !== 'string') return null;
  if (typeof row.lat !== 'number' || !Number.isFinite(row.lat)) return null;
  if (typeof row.lon !== 'number' || !Number.isFinite(row.lon)) return null;
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    admin1: typeof row.admin1 === 'string' ? row.admin1 : '',
    country: typeof row.country === 'string' ? row.country : '',
  };
}

/**
 * Parse the packed NDJSON (one JSON place per line) into entries. Resilient: a blank
 * or malformed line is skipped rather than aborting the load (one bad row never sinks
 * the dataset), mirroring the "one bad item never aborts the run" ethos of the M4-1
 * orchestrators.
 *
 * When one or more NON-BLANK rows are dropped (a JSON parse error, or a row that fails
 * narrowing), the total skip count is surfaced ONCE on the local console. Because
 * `Gazetteer.size` counts only the rows that loaded, this diagnostic is what lets an
 * operator tell a truncated/corrupt pack apart from a legitimately smaller sample
 * (#333) — mirroring the skip-count reporting of the sibling importers. Local console
 * ONLY; it never emits telemetry, honouring the strict local-only guarantee.
 */
export function parseGazetteerNdjson(text: string): GazetteerEntry[] {
  const entries: GazetteerEntry[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const entry = toGazetteerEntry(parsed);
    if (entry !== null) entries.push(entry);
    else skipped += 1;
  }
  if (skipped > 0) {
    // Local-only diagnostic (never telemetry): a non-zero skip count means the pack
    // lost rows to corruption/truncation, so its `size` under-reports the source.
    console.warn(
      `[kawsay] gazetteer: skipped ${skipped} malformed NDJSON row(s) while parsing; ${entries.length} row(s) loaded — a truncated or corrupt pack loads fewer entries than expected.`,
    );
  }
  return entries;
}

/** Path-resolution inputs for the bundled asset (all injectable for tests). */
export interface ResolveGazetteerOptions {
  /** Whether the app is packaged (`app.isPackaged`) — selects the base directory. */
  readonly isPackaged: boolean;
  /** `process.resourcesPath` — the packaged app's resources dir (used when packaged). */
  readonly resourcesPath: string;
  /** The app/repo root that contains the source `resources/` tree (used in dev). */
  readonly projectRoot: string;
  /** Existence probe (injected for tests); defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/**
 * Resolve the bundled asset path, PREFERRING the full packed asset and falling back to
 * the committed sample, or `null` when neither is present.
 *
 * - **Packaged:** `<process.resourcesPath>/gazetteer/<file>`.
 * - **Dev:** `<projectRoot>/resources/gazetteer/<file>`.
 */
export function resolveGazetteerAssetPath(options: ResolveGazetteerOptions): string | null {
  const exists = options.exists ?? existsSync;
  const dir = options.isPackaged
    ? join(options.resourcesPath, GAZETTEER_RESOURCE_SUBDIR)
    : join(options.projectRoot, 'resources', GAZETTEER_RESOURCE_SUBDIR);

  const fullAsset = join(dir, GAZETTEER_ASSET_FILENAME);
  if (exists(fullAsset)) return fullAsset;
  const sample = join(dir, GAZETTEER_SAMPLE_FILENAME);
  if (exists(sample)) return sample;
  return null;
}

/**
 * The BUILD-TIME opt-in gate signal (M4-2h, #270): whether a gazetteer asset (full
 * or sample) is bundled, so the UI knows whether to even OFFER place/theme
 * categorization. A pure path-presence probe — it never opens the network nor parses
 * a byte — mirroring `isEmbedModelPublished()` for smart search. Places need this
 * bundled asset; themes additionally need the opted-in embedder (resolved elsewhere),
 * degrading to places-only when the embedder is absent.
 */
export function isGazetteerBundled(options: ResolveGazetteerOptions): boolean {
  return resolveGazetteerAssetPath(options) !== null;
}

/** Collaborators for {@link loadGazetteer} (all injectable). */
export interface LoadGazetteerOptions extends ResolveGazetteerOptions {
  /** File reader (injected for tests); defaults to `fs.readFileSync(path, 'utf8')`. */
  readonly readFile?: (path: string) => string;
}

/**
 * Resolve, read, and parse the bundled gazetteer into a queryable {@link Gazetteer}.
 * Graceful by construction: when the asset is absent OR reading it fails, it returns
 * an EMPTY gazetteer (`size === 0`, `reverseGeocode` ⇒ `null`) instead of throwing —
 * so places simply cluster without a label, exactly the `embed-cli` UNAVAILABLE
 * degrade. NO network access of any kind.
 */
export function loadGazetteer(options: LoadGazetteerOptions): Gazetteer {
  const path = resolveGazetteerAssetPath(options);
  if (path === null) return createGazetteer([]);
  const readFile = options.readFile ?? ((target: string): string => readFileSync(target, 'utf8'));
  try {
    return createGazetteer(parseGazetteerNdjson(readFile(path)));
  } catch (err) {
    // `path` is an internal, resolver-produced asset path (never user/attacker input),
    // and a JS template literal is not a printf format string — so Semgrep's
    // unsafe-formatstring (CWE-134) taint match here is a false positive. The path is
    // deliberately kept inline in the message for triage (#331).
    console.warn(
      `[kawsay] gazetteer asset is present but could not be read/parsed (${path}); degrading to empty gazetteer.`, // nosemgrep: unsafe-formatstring
      err,
    );
    return createGazetteer([]);
  }
}
