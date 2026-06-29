import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../electron/main/importers/csv';

// A small, dependency-free RFC 4180 reader is the seam the LinkedIn importer
// (card C5, AC-16) parses every export CSV through. These tests pin the gnarly
// real-world cases LinkedIn ships — quoted commas/newlines, doubled-quote
// escapes, a UTF-8 BOM, and mixed CR/LF/CRLF line endings — so a cell's text is
// never truncated or split (the same "never silently drop a memory" guarantee
// the WhatsApp importer learned).

describe('parseCsv (RFC 4180 reader for LinkedIn exports, card C5)', () => {
  it('parses a simple header + rows into a matrix of fields', () => {
    expect(parseCsv('a,b,c\n1,2,3\n4,5,6\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('keeps a comma that is inside a quoted field as one field', () => {
    expect(parseCsv('name,note\n"García, José",hello\n')).toEqual([
      ['name', 'note'],
      ['García, José', 'hello'],
    ]);
  });

  it('keeps a newline that is inside a quoted field as part of that field', () => {
    expect(parseCsv('subject,body\n"hi","line one\nline two"\n')).toEqual([
      ['subject', 'body'],
      ['hi', 'line one\nline two'],
    ]);
  });

  it('unescapes a doubled double-quote ("") to a single quote inside a quoted field', () => {
    expect(parseCsv('q\n"she said ""hi"" today"\n')).toEqual([['q'], ['she said "hi" today']]);
  });

  it('strips a leading UTF-8 BOM from the very first field only', () => {
    const rows = parseCsv('\uFEFFFirst Name,Last Name\nJosé,García\n');
    expect(rows[0]).toEqual(['First Name', 'Last Name']);
    expect(rows[0]?.[0]).toBe('First Name');
  });

  it('handles CRLF, lone CR, and LF row terminators alike', () => {
    expect(parseCsv('a,b\r\n1,2\r3,4\n5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });

  it('does not emit a trailing empty row for a file that ends in a newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
  });

  it('parses a final row that has no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves an embedded CRLF inside a quoted field verbatim', () => {
    expect(parseCsv('x\n"a\r\nb"\n')).toEqual([['x'], ['a\r\nb']]);
  });

  it('returns an empty matrix for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('throws E_PARSE for an unterminated quoted field instead of keeping a truncated row', () => {
    expect(() => parseCsv('Content,From\n"hello,Ana\n')).toThrowError(
      expect.objectContaining({ code: 'E_PARSE' }),
    );
  });

  it('throws E_PARSE for a NUL byte in CSV text', () => {
    expect(() => parseCsv('Content,From\nhello\u0000there,Ana\n')).toThrowError(
      expect.objectContaining({ code: 'E_PARSE' }),
    );
  });

  it('keeps empty fields (consecutive commas) rather than collapsing them', () => {
    expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']]);
  });
});
