/**
 * A small, dependency-free RFC 4180 CSV reader — the seam every LinkedIn export
 * CSV (card C5, AC-16) is parsed through. LinkedIn ships ordinary comma files,
 * but real ones carry quoted fields with embedded commas and newlines, doubled
 * `""` escapes, a UTF-8 BOM on the first cell, and a mix of CR/LF/CRLF row
 * terminators (and `Connections.csv` even prepends a free-text "Notes:"
 * preamble). Splitting such a file naively on commas/newlines would truncate a
 * message or smear it across rows — the very "never silently drop a memory"
 * failure the WhatsApp importer was hardened against.
 *
 * The parser is a single forward pass over the text (no backtracking), so it is
 * linear and single-pass. It is intentionally lenient where LinkedIn is
 * (a bare `"` only opens a quoted run at a field boundary), and faithful where
 * it matters (every byte inside a quoted run is preserved verbatim). Header
 * interpretation — trimming, case-folding, locating the real header row past a
 * preamble — is the importer's job, not this reader's.
 */

/** Parse RFC 4180 CSV `input` into a matrix of rows × string fields. */
export function parseCsv(input: string): string[][] {
  // A UTF-8 BOM belongs to the document, never to the first header cell.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Whether the current row has seen any character at all — distinguishes a real
  // (possibly single-empty-field) row from the no-op state after a terminator,
  // so a trailing newline does not synthesize a phantom empty row.
  let rowHasContent = false;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    rowHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // A doubled quote inside a quoted run is one literal quote.
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      rowHasContent = true;
    } else if (ch === ',') {
      endField();
      rowHasContent = true;
    } else if (ch === '\r') {
      // Lone CR or CRLF — consume the paired LF so it is not read as a row.
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
      rowHasContent = true;
    }
  }

  // Flush a final row that did not end in a terminator (or an open quoted run
  // truncated by EOF — its text is still kept, never dropped).
  if (rowHasContent || field !== '' || row.length > 0) {
    endRow();
  }

  return rows;
}
