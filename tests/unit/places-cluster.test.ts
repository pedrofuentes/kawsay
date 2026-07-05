import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EPS_METERS,
  DEFAULT_MIN_PTS,
  clusterPlaces,
  clusterPlacesWithStats,
  haversineDistanceMeters,
  type GpsPoint,
  type PlacesClusterResult,
} from '../../electron/main/categorize/places-cluster';

const pt = (id: string, lat: number, lon: number): GpsPoint => ({ id, lat, lon });

// Metres → degrees of latitude for the module's spherical Earth model (latitude
// degrees are uniform), so a point offset by `metresToLatDeg(d)` is ~d metres
// away along a meridian. Used to build eps-boundary fixtures precisely.
const METRES_PER_DEG_LAT = 111194.93;
const metresToLatDeg = (metres: number): number => metres / METRES_PER_DEG_LAT;

// A stable, comparable snapshot of a result — for asserting determinism across
// repeated runs and across shuffled input order.
const snapshot = (
  result: PlacesClusterResult,
): {
  clusters: { clusterId: number; memberIds: readonly string[]; size: number }[];
  assignments: [string, number][];
  noise: readonly string[];
} => ({
  clusters: result.clusters.map((c) => ({
    clusterId: c.clusterId,
    memberIds: c.memberIds,
    size: c.size,
  })),
  assignments: [...result.assignments.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  noise: result.noise,
});

describe('haversineDistanceMeters (closed-form great-circle, zero dependency)', () => {
  it('is 0 between identical coordinates', () => {
    expect(haversineDistanceMeters({ lat: 40.4, lon: -3.7 }, { lat: 40.4, lon: -3.7 })).toBe(0);
  });

  it('is ~111.19 km for one degree of latitude', () => {
    const d = haversineDistanceMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it('shrinks by cos(lat) for one degree of longitude (≈half at 60°N)', () => {
    const atEquator = haversineDistanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    const at60 = haversineDistanceMeters({ lat: 60, lon: 0 }, { lat: 60, lon: 1 });
    expect(at60 / atEquator).toBeCloseTo(0.5, 2);
  });

  it('matches a known city-to-city great-circle distance (London↔Paris ≈ 343 km)', () => {
    const d = haversineDistanceMeters(
      { lat: 51.5074, lon: -0.1278 },
      { lat: 48.8566, lon: 2.3522 },
    );
    expect(d).toBeGreaterThan(340_000);
    expect(d).toBeLessThan(347_000);
  });

  it('is symmetric', () => {
    const a = { lat: 12.34, lon: 56.78 };
    const b = { lat: -9.87, lon: 65.43 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a), 6);
  });
});

describe('clusterPlaces — basic cluster formation', () => {
  it('groups nearby points and separates distant groups into distinct clusters', () => {
    const groupA = [
      pt('a1', 0, 0),
      pt('a2', metresToLatDeg(20), 0),
      pt('a3', 0, metresToLatDeg(20)),
    ];
    // Group B ~11 km north — far beyond eps.
    const groupB = [
      pt('b1', 0.1, 0),
      pt('b2', 0.1 + metresToLatDeg(20), 0),
      pt('b3', 0.1, metresToLatDeg(20)),
    ];
    const result = clusterPlaces([...groupA, ...groupB], { epsMeters: 1500, minPts: 3 });

    expect(result.clusters).toHaveLength(2);
    expect(result.noise).toEqual([]);
    const members = result.clusters.map((c) => [...c.memberIds]);
    expect(members).toContainEqual(['a1', 'a2', 'a3']);
    expect(members).toContainEqual(['b1', 'b2', 'b3']);
  });

  it('records every clustered id in assignments and leaves noise out of it', () => {
    const pts = [pt('p1', 0, 0), pt('p2', metresToLatDeg(20), 0), pt('p3', 0, metresToLatDeg(20))];
    const { assignments, noise } = clusterPlaces(pts, { epsMeters: 1500, minPts: 3 });
    expect(noise).toEqual([]);
    expect(assignments.get('p1')).toBe(0);
    expect(assignments.get('p2')).toBe(0);
    expect(assignments.get('p3')).toBe(0);
  });

  it('computes a cluster centroid at the arithmetic mean of its members', () => {
    const delta = metresToLatDeg(30);
    const pts = [pt('p1', 10, 20), pt('p2', 10 + delta, 20), pt('p3', 10, 20 + delta)];
    const { clusters } = clusterPlaces(pts, { epsMeters: 1500, minPts: 3 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.centroid.lat).toBeCloseTo(10 + delta / 3, 9);
    expect(clusters[0]?.centroid.lon).toBeCloseTo(20 + delta / 3, 9);
    expect(clusters[0]?.size).toBe(3);
  });
});

describe('clusterPlaces — eps boundary (the density boundary wins, not the grid cell)', () => {
  it('links two points just inside eps into one cluster', () => {
    const pts = [pt('x', 0, 0), pt('y', metresToLatDeg(1400), 0)]; // ~1.4 km < 1.5 km
    const { clusters, noise } = clusterPlaces(pts, { epsMeters: 1500, minPts: 2 });
    expect(noise).toEqual([]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberIds).toEqual(['x', 'y']);
  });

  it('leaves two points just outside eps as noise', () => {
    const pts = [pt('x', 0, 0), pt('y', metresToLatDeg(1600), 0)]; // ~1.6 km > 1.5 km
    const { clusters, noise } = clusterPlaces(pts, { epsMeters: 1500, minPts: 2 });
    expect(clusters).toEqual([]);
    expect(noise).toEqual(['x', 'y']);
  });

  it('includes an in-eps satellite but excludes an out-of-eps one', () => {
    const core = [pt('c1', 0, 0), pt('c2', metresToLatDeg(10), 0)];
    const inSat = pt('in', metresToLatDeg(1400), 0); // ~1.4 km north of the core
    const outSat = pt('out', -metresToLatDeg(1600), 0); // ~1.6 km south — beyond eps
    const { clusters, noise } = clusterPlaces([...core, inSat, outSat], {
      epsMeters: 1500,
      minPts: 2,
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberIds).toEqual(['c1', 'c2', 'in']);
    expect(noise).toEqual(['out']);
  });
});

describe('clusterPlaces — isolated points, noise, and empty input', () => {
  it('marks a point with no neighbour as noise, never a lone cluster', () => {
    const pts = [
      pt('c1', 0, 0),
      pt('c2', metresToLatDeg(20), 0),
      pt('c3', 0, metresToLatDeg(20)),
      pt('lonely', 5, 5), // thousands of km away
    ];
    const { clusters, assignments, noise } = clusterPlaces(pts, { epsMeters: 1500, minPts: 3 });
    expect(clusters).toHaveLength(1);
    expect(noise).toEqual(['lonely']);
    expect(assignments.has('lonely')).toBe(false);
    expect(assignments.get('c1')).toBe(0);
  });

  it('returns an empty result for empty input', () => {
    const result = clusterPlaces([], { epsMeters: 1500, minPts: 3 });
    expect(result.clusters).toEqual([]);
    expect(result.noise).toEqual([]);
    expect([...result.assignments.entries()]).toEqual([]);
  });

  it('marks all points as noise when none reaches minPts density', () => {
    // Points pairwise > eps apart, minPts 3 → no core points at all.
    const pts = [pt('p1', 0, 0), pt('p2', 1, 0), pt('p3', 2, 0)];
    const { clusters, noise } = clusterPlaces(pts, { epsMeters: 1500, minPts: 3 });
    expect(clusters).toEqual([]);
    expect(noise).toEqual(['p1', 'p2', 'p3']);
  });

  it('clusters coincident (identical-coordinate) points together', () => {
    const pts = [pt('d1', 12, 34), pt('d2', 12, 34), pt('d3', 12, 34)];
    const { clusters, noise } = clusterPlaces(pts, { epsMeters: 1500, minPts: 3 });
    expect(noise).toEqual([]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberIds).toEqual(['d1', 'd2', 'd3']);
  });
});

describe('clusterPlaces — determinism (stable cluster ids, input-order independent)', () => {
  const build = (): GpsPoint[] => [
    pt('a1', 0, 0),
    pt('a2', metresToLatDeg(20), 0),
    pt('a3', 0, metresToLatDeg(20)),
    pt('b1', 0.2, 0.2),
    pt('b2', 0.2 + metresToLatDeg(20), 0.2),
    pt('b3', 0.2, 0.2 + metresToLatDeg(20)),
    pt('n1', 5, 5),
  ];
  const opts = { epsMeters: 1500, minPts: 3 };

  it('is identical across repeated runs on the same input', () => {
    expect(snapshot(clusterPlaces(build(), opts))).toEqual(snapshot(clusterPlaces(build(), opts)));
  });

  it('is independent of input order (stable ids and membership under shuffling)', () => {
    const forward = clusterPlaces(build(), opts);
    const reversed = clusterPlaces([...build()].reverse(), opts);
    expect(snapshot(reversed)).toEqual(snapshot(forward));
  });

  it('assigns cluster ids by ascending member id (lowest-id core cluster is 0)', () => {
    const { clusters, assignments } = clusterPlaces(build(), opts);
    expect(clusters.map((c) => c.clusterId)).toEqual([0, 1]);
    expect(assignments.get('a1')).toBe(0);
    expect(assignments.get('b1')).toBe(1);
    expect(clusters[0]?.memberIds).toEqual(['a1', 'a2', 'a3']);
    expect(clusters[1]?.memberIds).toEqual(['b1', 'b2', 'b3']);
    const ascending = clusters.every((c) =>
      c.memberIds.every((id, i) => i === 0 || (c.memberIds[i - 1] ?? '') < id),
    );
    expect(ascending).toBe(true);
  });
});

describe('clusterPlaces — configurable options with documented defaults', () => {
  it('exposes the ADR-0030 defaults (eps ≈ 1.5 km, small minPts)', () => {
    expect(DEFAULT_EPS_METERS).toBe(1500);
    expect(DEFAULT_MIN_PTS).toBe(3);
  });

  it('uses the defaults when options are omitted', () => {
    // Three points within the 1.5 km default eps of one another, meeting the
    // default minPts of 3 — one cluster with no options passed.
    const pts = [
      pt('p1', 0, 0),
      pt('p2', metresToLatDeg(1200), 0),
      pt('p3', metresToLatDeg(600), metresToLatDeg(600)),
    ];
    const { clusters, noise } = clusterPlaces(pts);
    expect(noise).toEqual([]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('honours a smaller eps that splits an otherwise-single cluster', () => {
    const pts = [pt('p1', 0, 0), pt('p2', metresToLatDeg(1200), 0)];
    // 1200 m apart: together under the default eps, but noise under a 500 m eps.
    expect(clusterPlaces(pts, { epsMeters: 500, minPts: 2 }).noise).toEqual(['p1', 'p2']);
    expect(clusterPlaces(pts, { epsMeters: 1500, minPts: 2 }).clusters).toHaveLength(1);
  });
});

describe('clusterPlaces — border-point reclaim (mutation-discriminating)', () => {
  // A low-id, non-core point processed first — labelled NOISE — must be
  // reclaimed when a later, higher-id CORE point's expansion reaches it. If the
  // reclaim branch is removed or neutered, `a` stays in the noise list and this
  // test fails. Constructed so `a` is decisively non-core (only one neighbour
  // within eps) yet decisively reachable from cluster `b` (well inside eps).
  it('reclaims a previously-noise low-id point as a border of a later core cluster', () => {
    const eps = 1500;
    const minPts = 3;
    // `a` at (0, 0). `b` is 1400 m north — inside eps of `a` (so `b` will find
    // `a` when it expands) but `c` and `d` sit ~2500 m north — beyond eps of
    // `a`, so `a`'s own neighbourhood is only { a, b } = 2 < minPts → NOISE.
    // `b`, `c`, `d` are mutually within eps and together satisfy the density
    // check that makes `b` a core seed once the outer loop reaches it.
    const a = pt('a', 0, 0);
    const b = pt('b', metresToLatDeg(1400), 0);
    const c = pt('c', metresToLatDeg(2400), 0);
    const d = pt('d', metresToLatDeg(2500), 0);

    // Pre-conditions the fixture depends on (guard against unit drift).
    expect(haversineDistanceMeters(a, b)).toBeLessThan(eps);
    expect(haversineDistanceMeters(a, c)).toBeGreaterThan(eps);
    expect(haversineDistanceMeters(a, d)).toBeGreaterThan(eps);
    expect(haversineDistanceMeters(b, c)).toBeLessThan(eps);
    expect(haversineDistanceMeters(b, d)).toBeLessThan(eps);
    expect(haversineDistanceMeters(c, d)).toBeLessThan(eps);

    const { clusters, assignments, noise } = clusterPlaces([a, b, c, d], {
      epsMeters: eps,
      minPts,
    });

    // `a` must be RECLAIMED into the cluster, not left as noise. If the
    // reclaim branch is removed, `a` ends up in `noise` and this fails.
    expect(noise).toEqual([]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberIds).toEqual(['a', 'b', 'c', 'd']);
    expect(assignments.get('a')).toBe(0);
  });
});

describe('clusterPlaces — dense-cell complexity bound (#313)', () => {
  // A single coordinate holding many photos (a home GPS) is folded to one
  // representative before DBSCAN so grid.neighbours() runs O(unique-coords)
  // times, not O(input-points). Without this fold, a 5 000-clone fixture drives
  // ~25 million haversine evaluations; with the fold it drives one query.
  it('folds coincident coordinates so neighbourhood queries scale with unique coords', () => {
    const N = 5_000;
    const clones: GpsPoint[] = [];
    for (let i = 0; i < N; i += 1) {
      // Zero-padded ids so ascending id order is deterministic and stable.
      clones.push(pt(`p${String(i).padStart(5, '0')}`, 40.4168, -3.7038));
    }

    const { result, stats } = clusterPlacesWithStats(clones, { epsMeters: 1500, minPts: 3 });

    // Output correctness: all clones land in a single cluster, no noise.
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.size).toBe(N);
    expect(result.noise).toEqual([]);

    // Complexity bound: exactly one coordinate → exactly one representative,
    // and grid.neighbours() is invoked at most once per representative. The
    // pre-fold implementation would report N here.
    expect(stats.representativeCount).toBe(1);
    expect(stats.neighbourQueries).toBeLessThanOrEqual(stats.representativeCount);
  });

  it('folds coincident coordinates without altering the result of a mixed fixture', () => {
    // Two co-located home groups plus a sparse outlier: fold must not perturb
    // cluster ids, membership, centroids, or noise vs. the unfolded reference.
    const home = Array.from({ length: 20 }, (_, i) =>
      pt(`home${String(i).padStart(3, '0')}`, 40.4168, -3.7038),
    );
    const park = Array.from({ length: 15 }, (_, i) =>
      pt(`park${String(i).padStart(3, '0')}`, 40.5, -3.7),
    );
    const lonely = pt('zzz-lonely', 41.9, 12.5);
    const input = [...home, ...park, lonely];

    const { result, stats } = clusterPlacesWithStats(input, { epsMeters: 1500, minPts: 3 });

    // Two unique coords in the clusters (home, park) + one for the outlier = 3.
    expect(stats.representativeCount).toBe(3);
    // At most one neighbourhood query per representative.
    expect(stats.neighbourQueries).toBeLessThanOrEqual(stats.representativeCount);

    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]?.size).toBe(home.length);
    expect(result.clusters[1]?.size).toBe(park.length);
    expect(result.noise).toEqual(['zzz-lonely']);

    // The public entry point returns the identical result.
    const publicResult = clusterPlaces(input, { epsMeters: 1500, minPts: 3 });
    expect(snapshot(publicResult)).toEqual(snapshot(result));
  });
});
