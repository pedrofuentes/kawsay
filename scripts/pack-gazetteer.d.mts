// Hand-written type declarations for scripts/pack-gazetteer.mjs (a plain ESM
// release-tooling script run under bare `node`), so tests/unit/pack-gazetteer.test.ts
// can import its exports under `tsc --strict`. Same approach as the other
// type-only shims in the repo (e.g. scripts/verify-media-binaries.d.mts). Keep in
// lock-step with the .mjs module's exports.

export interface TrimmedRow {
  readonly id: number;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly admin1: string;
  readonly country: string;
  readonly population: number;
}

export const CITIES1000_URL: string;
export const CITIES1000_SHA256: string;

export function download(url: string): Promise<Buffer>;
export function readZipEntry(zipBuffer: Buffer, entryName?: string): Promise<string>;
export function trimRows(tsv: string): TrimmedRow[];
export function toNdjson(rows: readonly TrimmedRow[]): string;
export function topByPopulation(rows: readonly TrimmedRow[], limit: number): TrimmedRow[];
export function parseSampleSize(args: readonly string[]): number | null;
export function verifySha256(buffer: Buffer, expectedHex: string): string;
