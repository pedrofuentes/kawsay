import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CITIES1000_SHA256,
  CITIES1000_URL,
  parseSampleSize,
  toNdjson,
  topByPopulation,
  trimRows,
  verifySha256,
} from '../../scripts/pack-gazetteer.mjs';

// GeoNames cities1000.txt is tab-separated with a fixed column order. These
// fixtures use the same 0-indexed columns the packer reads (0=geonameid,
// 1=name, 4=lat, 5=lon, 8=country, 10=admin1, 14=population); columns not read
// are filled with placeholder markers so a wrong column index in the packer
// (regression) would surface as garbage instead of the expected value.
function tsvRow(fields: {
  id: string;
  name: string;
  lat: string;
  lon: string;
  country: string;
  admin1: string;
  population: string;
}): string {
  const cols = new Array<string>(19).fill('-');
  cols[0] = fields.id;
  cols[1] = fields.name;
  cols[4] = fields.lat;
  cols[5] = fields.lon;
  cols[8] = fields.country;
  cols[10] = fields.admin1;
  cols[14] = fields.population;
  return cols.join('\t');
}

const CUZCO = tsvRow({
  id: '3931276',
  name: 'Cuzco',
  lat: '-13.52264',
  lon: '-71.96733',
  country: 'PE',
  admin1: '18',
  population: '312140',
});
const LIMA = tsvRow({
  id: '3936456',
  name: 'Lima',
  lat: '-12.04318',
  lon: '-77.02824',
  country: 'PE',
  admin1: '15',
  population: '7737002',
});
const AREQUIPA = tsvRow({
  id: '3947322',
  name: 'Arequipa',
  lat: '-16.39889',
  lon: '-71.535',
  country: 'PE',
  admin1: '04',
  population: '841130',
});

describe('pack-gazetteer helpers (#332)', () => {
  describe('trimRows', () => {
    it('projects TSV to the six-field shape kept by the packer', () => {
      const rows = trimRows(CUZCO);
      expect(rows).toEqual([
        {
          id: 3931276,
          name: 'Cuzco',
          lat: -13.52264,
          lon: -71.96733,
          admin1: '18',
          country: 'PE',
          population: 312140,
        },
      ]);
    });

    it('drops malformed rows (missing name, unparseable coord) and empty lines', () => {
      const missingName = tsvRow({
        id: '1',
        name: '',
        lat: '10',
        lon: '20',
        country: 'XX',
        admin1: '01',
        population: '100',
      });
      const badLat = tsvRow({
        id: '2',
        name: 'BadLat',
        lat: 'not-a-number',
        lon: '20',
        country: 'XX',
        admin1: '01',
        population: '100',
      });
      const tsv = [missingName, '', badLat, LIMA].join('\n');
      const rows = trimRows(tsv);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('Lima');
    });

    it('defaults missing population to 0 without dropping the row', () => {
      const noPop = tsvRow({
        id: '99',
        name: 'Nowhere',
        lat: '0',
        lon: '0',
        country: 'XX',
        admin1: '',
        population: '',
      });
      const rows = trimRows(noPop);
      expect(rows[0]?.population).toBe(0);
    });
  });

  describe('topByPopulation', () => {
    it('sorts descending by population and truncates to the limit', () => {
      const rows = trimRows([CUZCO, LIMA, AREQUIPA].join('\n'));
      const top2 = topByPopulation(rows, 2);
      expect(top2.map((r) => r.name)).toEqual(['Lima', 'Arequipa']);
    });

    it('breaks population ties by ascending geonameid for byte-stable output', () => {
      const tieB = tsvRow({
        id: '200',
        name: 'B',
        lat: '0',
        lon: '0',
        country: 'XX',
        admin1: '',
        population: '500',
      });
      const tieA = tsvRow({
        id: '100',
        name: 'A',
        lat: '0',
        lon: '0',
        country: 'XX',
        admin1: '',
        population: '500',
      });
      const rows = trimRows([tieB, tieA].join('\n'));
      const sorted = topByPopulation(rows, 5);
      expect(sorted.map((r) => r.id)).toEqual([100, 200]);
    });

    it('does not mutate its input array', () => {
      const rows = trimRows([CUZCO, LIMA].join('\n'));
      const before = rows.map((r) => r.id);
      topByPopulation(rows, 1);
      expect(rows.map((r) => r.id)).toEqual(before);
    });
  });

  describe('toNdjson', () => {
    it('emits one JSON object per row (population dropped) with trailing newline', () => {
      const rows = trimRows([CUZCO, LIMA].join('\n'));
      const ndjson = toNdjson(rows);
      const lines = ndjson.split('\n');
      expect(lines[lines.length - 1]).toBe('');
      const parsed = lines.slice(0, -1).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(parsed).toEqual([
        { id: 3931276, name: 'Cuzco', lat: -13.52264, lon: -71.96733, admin1: '18', country: 'PE' },
        {
          id: 3936456,
          name: 'Lima',
          lat: -12.04318,
          lon: -77.02824,
          admin1: '15',
          country: 'PE',
        },
      ]);
      expect(parsed[0]).not.toHaveProperty('population');
    });

    it('emits a single trailing newline for an empty input', () => {
      expect(toNdjson([])).toBe('\n');
    });
  });

  describe('parseSampleSize', () => {
    it('returns null (full-asset mode) when --sample is absent', () => {
      expect(parseSampleSize([])).toBeNull();
      expect(parseSampleSize(['--other', '--flag=1'])).toBeNull();
    });

    it('returns the default sample size for the bare --sample flag', () => {
      expect(parseSampleSize(['--sample'])).toBe(128);
    });

    it('returns the parsed value for --sample=N', () => {
      expect(parseSampleSize(['--sample=42'])).toBe(42);
    });

    it('falls back to the default when N is not a positive integer', () => {
      expect(parseSampleSize(['--sample=0'])).toBe(128);
      expect(parseSampleSize(['--sample=-5'])).toBe(128);
      expect(parseSampleSize(['--sample=oops'])).toBe(128);
    });
  });
});

describe('pack-gazetteer download integrity (#330)', () => {
  it('exposes the pinned upstream URL and a 64-char lowercase-hex SHA-256 pin', () => {
    expect(CITIES1000_URL).toBe('https://download.geonames.org/export/dump/cities1000.zip');
    expect(CITIES1000_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a buffer whose SHA-256 matches the expected hex and returns the digest', () => {
    const bytes = Buffer.from('kawsay-gazetteer-fixture');
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(verifySha256(bytes, expected)).toBe(expected);
  });

  it('aborts with an error naming both digests when the buffer is tampered', () => {
    const original = Buffer.from('kawsay-gazetteer-fixture');
    const expected = createHash('sha256').update(original).digest('hex');
    const tampered = Buffer.from('kawsay-gazetteer-fixture!');
    const actual = createHash('sha256').update(tampered).digest('hex');
    expect(() => verifySha256(tampered, expected)).toThrow(
      new RegExp(`SHA-256 mismatch.*${expected}.*${actual}`, 's'),
    );
  });

  it('is case-insensitive on the expected hex (accepts UPPER + lower)', () => {
    const bytes = Buffer.from('kawsay-gazetteer-fixture');
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(verifySha256(bytes, expected.toUpperCase())).toBe(expected);
  });
});
