// Pure, dependency-free places clustering over EXIF GPS coordinates
// (ADR-0030 Decision 2, milestone M4-2). Like `search/semantic.ts`, this module
// has NO database, model, or filesystem dependency: it takes the GPS points as a
// plain array argument (the orchestrator, #269, feeds it `items.gps_lat/gps_lon`
// rows) and is exhaustively unit-tested with synthetic coordinates.
//
// The pipeline is DBSCAN-style density clustering over a haversine metric, with a
// coarse degree-grid spatial index so neighbourhood search stays sub-second at v1
// scale (10k–100k items). The grid is ONLY an index — it returns a superset of
// each point's eps-neighbourhood and the exact haversine distance decides
// membership, so a coherent place is never split on a cell edge (the density
// boundary wins, not the bucket boundary). Ordering is deterministic (points are
// processed in ascending id order, clusters are numbered by discovery), so the
// same input always yields byte-identical output — mirroring the determinism
// discipline of `semantic.ts`.

/** A latitude/longitude coordinate in decimal degrees (WGS84). */
export interface GeoCoord {
  readonly lat: number;
  readonly lon: number;
}

/** An input point: an item id plus its catalogued GPS coordinate. */
export interface GpsPoint extends GeoCoord {
  readonly id: string;
}

/** Tuning for {@link clusterPlaces}; both fields default per ADR-0030. */
export interface PlacesClusterOptions {
  /** Neighbourhood radius in metres (the DBSCAN `eps`). Default {@link DEFAULT_EPS_METERS}. */
  readonly epsMeters?: number;
  /**
   * Minimum points (INCLUDING the point itself) within `eps` for a point to be a
   * core point / seed a cluster (the DBSCAN `minPts`). Default {@link DEFAULT_MIN_PTS}.
   */
  readonly minPts?: number;
}

/** One discovered place cluster. */
export interface PlaceCluster {
  /** Deterministic 0-based id: clusters are numbered in order of discovery. */
  readonly clusterId: number;
  /** Member item ids, ascending — stable across runs and input orderings. */
  readonly memberIds: readonly string[];
  /** Arithmetic-mean coordinate of the members (the reverse-geocode anchor). */
  readonly centroid: GeoCoord;
  /** Member count (`= memberIds.length`). */
  readonly size: number;
}

/** The result of {@link clusterPlaces}. */
export interface PlacesClusterResult {
  /** Clusters ordered by ascending {@link PlaceCluster.clusterId}. */
  readonly clusters: readonly PlaceCluster[];
  /** Item id → cluster id for every CLUSTERED point (noise is excluded). */
  readonly assignments: ReadonlyMap<string, number>;
  /** Item ids that reached no cluster (DBSCAN noise), ascending. */
  readonly noise: readonly string[];
}

/** Default `eps` — 1.5 km, the middle of ADR-0030's 1–2 km band. */
export const DEFAULT_EPS_METERS = 1500;
/** Default `minPts` — small, so a handful of nearby photos already form a place. */
export const DEFAULT_MIN_PTS = 3;

// IUGG mean Earth radius; the same sphere is used for the grid, so metres↔degrees
// conversions there are exactly consistent with these distances.
const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_DEGREE_LAT = (Math.PI / 180) * EARTH_RADIUS_METERS;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two coordinates in metres, via the closed-form
 * haversine formula on a spherical Earth. Zero dependency; symmetric; 0 for
 * identical coordinates. `asin` is clamped to guard against a >1 argument from
 * floating-point rounding at antipodal points.
 */
export function haversineDistanceMeters(a: GeoCoord, b: GeoCoord): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A coarse degree-grid spatial index over the input points. Cells are ~`eps` in
 * size, so every point within `eps` of a query lies in the query's cell or an
 * adjacent one; a neighbourhood query therefore scans a small, bounded set of
 * cells and returns a SUPERSET of the true eps-neighbourhood, which the caller
 * refines with an exact haversine check. Longitude cells are treated as a ring
 * (wrap-around at the antimeridian) and the longitude span widens by 1/cos(lat)
 * toward the poles, so the superset guarantee holds at every latitude.
 */
class DegreeGrid {
  private readonly cellDeg: number;
  private readonly lonCellCount: number;
  private readonly cells = new Map<string, GpsPoint[]>();

  constructor(points: readonly GpsPoint[], epsMeters: number) {
    // One cell spans exactly `eps` of latitude (latitude degrees are uniform), so
    // ±1 latitude cell always covers `eps` vertically.
    this.cellDeg = epsMeters / METERS_PER_DEGREE_LAT;
    this.lonCellCount = Math.max(1, Math.ceil(360 / this.cellDeg));
    for (const point of points) {
      const key = this.keyFor(point.lat, point.lon);
      const bucket = this.cells.get(key);
      if (bucket === undefined) this.cells.set(key, [point]);
      else bucket.push(point);
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
    return `${this.latCell(lat)},${this.lonCell(lon)}`;
  }

  /**
   * All points within `epsMeters` of `origin` (exact haversine), found by scanning
   * only the origin's cell and its neighbours. `origin` itself is included.
   */
  neighbours(origin: GpsPoint, epsMeters: number): GpsPoint[] {
    const originLatCell = this.latCell(origin.lat);
    const originLonCell = this.lonCell(origin.lon);

    // Longitude compresses by cos(lat): `eps` spans ~1/cos(lat) cells. Use the most
    // poleward latitude reachable within one cell, plus a 1-cell safety margin.
    const worstLatDeg = Math.min(90, Math.abs(origin.lat) + this.cellDeg);
    const cosLat = Math.max(Math.cos(toRadians(worstLatDeg)), Number.EPSILON);
    const lonSpan = Math.ceil(1 / cosLat) + 1;

    const found: GpsPoint[] = [];
    const scanCell = (latCell: number, lonCell: number): void => {
      const bucket = this.cells.get(`${latCell},${lonCell}`);
      if (bucket === undefined) return;
      for (const candidate of bucket) {
        if (haversineDistanceMeters(origin, candidate) <= epsMeters) found.push(candidate);
      }
    };

    for (let dLat = -1; dLat <= 1; dLat += 1) {
      const latCell = originLatCell + dLat;
      if (2 * lonSpan + 1 >= this.lonCellCount) {
        // The span wraps the whole ring (only near the poles): scan every longitude
        // cell in this latitude row exactly once.
        for (let lonCell = 0; lonCell < this.lonCellCount; lonCell += 1) scanCell(latCell, lonCell);
      } else {
        for (let dLon = -lonSpan; dLon <= lonSpan; dLon += 1) {
          const lonCell =
            (((originLonCell + dLon) % this.lonCellCount) + this.lonCellCount) % this.lonCellCount;
          scanCell(latCell, lonCell);
        }
      }
    }
    return found;
  }
}

/**
 * Cluster GPS points by geographic density (DBSCAN over a haversine metric),
 * pure and dependency-free.
 *
 * A point is a CORE point when at least `minPts` points (including itself) lie
 * within `epsMeters`; clusters grow by density-reachability from core points.
 * Points reachable from a core but not themselves core are BORDER members;
 * points reached by neither are NOISE and appear only in
 * {@link PlacesClusterResult.noise}.
 *
 * Determinism: points are processed in ascending id order and clusters are
 * numbered in order of discovery, so cluster ids, membership, and centroids are
 * identical across runs and independent of the input array's order (a border
 * point reachable from two clusters joins the one whose core has the lower id).
 *
 * Dense-cell bound: bit-identical coordinates (e.g. thousands of photos taken
 * at one home GPS) are folded into a single WEIGHTED representative before
 * DBSCAN runs. Clones share every haversine distance by definition, so this
 * fold is a pure algorithmic optimisation — output ids, membership, and
 * cluster ids are identical to the pre-fold behaviour, and centroids are
 * identical up to floating-point rounding (a weighted `rep.lat * weight` sum
 * can differ from adding each member individually by ≤1 ULP — ≪1 mm) — that
 * bounds neighbourhood queries by the number of unique coordinates rather than
 * the number of input points.
 */
export function clusterPlaces(
  points: readonly GpsPoint[],
  options: PlacesClusterOptions = {},
): PlacesClusterResult {
  return runClusterPlaces(points, options).result;
}

/**
 * Complexity metrics collected during a run of {@link clusterPlaces}.
 *
 * @internal Test-only surface for asserting the dense-cell bound (#313); not
 * part of the stable public API and not consumed by production callers.
 */
export interface ClusterPlacesStats {
  /** Number of representatives DBSCAN iterated over (= unique coordinates). */
  readonly representativeCount: number;
  /** Number of `grid.neighbours()` invocations across the whole run. */
  readonly neighbourQueries: number;
  /** Total input points as received by the entry point. */
  readonly inputPointCount: number;
}

/**
 * Same as {@link clusterPlaces} but also returns run-time complexity metrics.
 *
 * @internal Test-only. Kept in this module to avoid duplicating the algorithm;
 * production code should use {@link clusterPlaces}. Semantics of `result` are
 * identical to {@link clusterPlaces}.
 */
export function clusterPlacesWithStats(
  points: readonly GpsPoint[],
  options: PlacesClusterOptions = {},
): { readonly result: PlacesClusterResult; readonly stats: ClusterPlacesStats } {
  return runClusterPlaces(points, options);
}

// Internal group of input points that share a bit-identical (lat, lon). All
// members of a group have, by construction, the exact same eps-neighbourhood
// under any haversine query — so DBSCAN can iterate a single WEIGHTED
// representative per group without changing labels, centroids, or noise.
interface CoordGroup {
  readonly rep: GpsPoint;
  readonly memberIds: string[]; // appended in ascending-id order below.
}

function runClusterPlaces(
  points: readonly GpsPoint[],
  options: PlacesClusterOptions,
): { result: PlacesClusterResult; stats: ClusterPlacesStats } {
  const epsMeters = options.epsMeters ?? DEFAULT_EPS_METERS;
  const minPts = options.minPts ?? DEFAULT_MIN_PTS;

  // Reject programmer misuse early with a clear error rather than silently
  // building a degenerate grid (eps ≤ 0/NaN) or applying an impossible density
  // threshold (minPts < 1 or fractional). Both defaults are valid, so callers
  // that omit the options never trip these guards.
  if (!Number.isFinite(epsMeters) || epsMeters <= 0) {
    throw new RangeError(
      `clusterPlaces: epsMeters must be a finite number > 0 (got ${epsMeters}).`,
    );
  }
  if (!Number.isInteger(minPts) || minPts < 1) {
    throw new RangeError(`clusterPlaces: minPts must be an integer >= 1 (got ${minPts}).`);
  }

  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  // Stable processing order: ascending id. Cluster ids follow discovery order,
  // so this makes the whole result independent of the caller's array order.
  const ordered = [...points].sort((a, b) => byId(a.id, b.id));

  // Fold bit-identical coordinates into weighted CoordGroups. Because we walk
  // `ordered` in ascending id, the FIRST point observed for any (lat, lon) is
  // the group's canonical representative — its id is the lowest in the group,
  // matching the discovery order the original per-point pass would have used
  // when it first entered that coordinate's cell.
  const groupByKey = new Map<string, CoordGroup>();
  for (const point of ordered) {
    // Numeric coercion via template string is stable for finite doubles and
    // collapses `-0` and `+0` (both stringify to "0"). Points that are merely
    // "near-coincident" but not bit-identical are NOT folded — that would risk
    // changing outputs when a satellite point sits just inside eps of one
    // clone and just outside eps of another.
    const key = `${point.lat},${point.lon}`;
    const existing = groupByKey.get(key);
    if (existing === undefined) groupByKey.set(key, { rep: point, memberIds: [point.id] });
    else existing.memberIds.push(point.id);
  }

  // Representatives ordered by rep id — DBSCAN's outer loop must visit them in
  // the same order the original per-point loop would have visited each group's
  // first (= lowest-id) member.
  const groups = [...groupByKey.values()].sort((a, b) => byId(a.rep.id, b.rep.id));
  const reps = groups.map((g) => g.rep);
  const groupByRepId = new Map<string, CoordGroup>();
  for (const group of groups) groupByRepId.set(group.rep.id, group);

  const stats = {
    representativeCount: reps.length,
    neighbourQueries: 0,
    inputPointCount: ordered.length,
  };

  const grid = new DegreeGrid(reps, epsMeters);

  // Weighted core check: sum the member counts of every representative in the
  // returned neighbourhood so a lone rep speaking for k clones contributes k.
  const totalWeight = (found: readonly GpsPoint[]): number => {
    let sum = 0;
    for (const p of found) {
      const g = groupByRepId.get(p.id) as CoordGroup;
      sum += g.memberIds.length;
    }
    return sum;
  };

  const UNVISITED = 0;
  const NOISE = -1;
  // `visited` is the authoritative "already processed" guard; `label` records
  // only the outcome we still need afterwards — NOISE, or the owning cluster
  // id — so the UNVISITED/cluster-0 sentinel overlap is harmless (label is
  // never read to decide visitation, only to detect a reclaimable NOISE border
  // and the final noise list).
  const label = new Map<string, number>();
  const visited = new Set<string>();
  for (const rep of reps) label.set(rep.id, UNVISITED);

  const clusterRepIds: string[][] = [];

  for (const rep of reps) {
    if (visited.has(rep.id)) continue;
    visited.add(rep.id);

    stats.neighbourQueries += 1;
    const neighbourhood = grid.neighbours(rep, epsMeters);
    if (totalWeight(neighbourhood) < minPts) {
      label.set(rep.id, NOISE); // may later be reclaimed as a border point
      continue;
    }

    const clusterId = clusterRepIds.length;
    const cluster: string[] = [];
    clusterRepIds.push(cluster);

    label.set(rep.id, clusterId);
    cluster.push(rep.id);

    // Breadth-first expansion over the seed set. A "queued" guard keeps each
    // representative enqueued at most once; iteration order does not affect
    // the final membership — only the deterministic outer id order matters
    // for border-point assignment.
    const queue: GpsPoint[] = neighbourhood.filter((n) => n.id !== rep.id);
    const queued = new Set<string>(queue.map((n) => n.id));
    queued.add(rep.id);

    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i] as GpsPoint;
      if (!visited.has(current.id)) {
        visited.add(current.id);
        label.set(current.id, clusterId);
        cluster.push(current.id);

        stats.neighbourQueries += 1;
        const currentNeighbours = grid.neighbours(current, epsMeters);
        if (totalWeight(currentNeighbours) >= minPts) {
          for (const next of currentNeighbours) {
            if (queued.has(next.id)) continue;
            queued.add(next.id);
            queue.push(next);
          }
        }
      } else if (label.get(current.id) === NOISE) {
        // Previously-noise representative is a border of this cluster: claim
        // it (and, on expansion below, all its clones).
        label.set(current.id, clusterId);
        cluster.push(current.id);
      }
    }
  }

  const clusters: PlaceCluster[] = clusterRepIds.map((repIds, clusterId) => {
    // Expand each rep back to its full group of bit-identical clones and take
    // the weighted centroid — mathematically identical to averaging over every
    // individual point (all clones in a group share the rep's coordinate).
    const allMemberIds: string[] = [];
    let latSum = 0;
    let lonSum = 0;
    for (const repId of repIds) {
      const group = groupByRepId.get(repId) as CoordGroup;
      for (const id of group.memberIds) allMemberIds.push(id);
      const weight = group.memberIds.length;
      latSum += group.rep.lat * weight;
      lonSum += group.rep.lon * weight;
    }
    allMemberIds.sort(byId);
    return {
      clusterId,
      memberIds: allMemberIds,
      centroid: { lat: latSum / allMemberIds.length, lon: lonSum / allMemberIds.length },
      size: allMemberIds.length,
    };
  });

  const assignments = new Map<string, number>();
  for (const cluster of clusters) {
    for (const id of cluster.memberIds) assignments.set(id, cluster.clusterId);
  }

  const noiseIds: string[] = [];
  for (const rep of reps) {
    if (label.get(rep.id) !== NOISE) continue;
    const group = groupByRepId.get(rep.id) as CoordGroup;
    for (const id of group.memberIds) noiseIds.push(id);
  }
  noiseIds.sort(byId);

  return { result: { clusters, assignments, noise: noiseIds }, stats };
}
