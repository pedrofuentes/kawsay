import { basename, join, relative, sep } from 'node:path';
import type {
  CatalogRecord,
  ImportContext,
  Importer,
  ImporterDeps,
  ImportResult,
  SkippedItem,
} from './types';
import { parseCsv } from './csv';
import { zipHasEntryName } from './zip-markers';

/**
 * Card C5 (AC-16): the **LinkedIn** connector. LinkedIn's "Download your data"
 * export is a `.zip` of CSV files — `messages.csv`, `Connections.csv`, and
 * `Rich_Media.csv` — opened through the injected, zip-slip-guarded
 * {@link ImporterDeps.extractArchive} (never a raw unzip) or read from a folder
 * the user already extracted. Every CSV is parsed through the shared, RFC 4180
 * {@link parseCsv} reader so a quoted comma, an embedded newline, a doubled `""`,
 * a UTF-8 BOM, or the free-text "Notes:" preamble LinkedIn prepends to
 * `Connections.csv` can never truncate a message or smear it across rows — the
 * "never silently drop a memory" rule the WhatsApp importer was hardened for.
 *
 * Unlike Facebook DYI, LinkedIn CSV text is already faithful UTF-8, so names and
 * messages are used verbatim (re-decoding them would corrupt accents). Header
 * names vary across export versions, so columns are matched case- and
 * space-insensitively against a small set of synonyms, and the real header row is
 * located past any preamble. Dates come in several shapes ("YYYY-MM-DD HH:MM:SS
 * UTC", "DD Mon YYYY", "MM/DD/YYYY"); all are read as UTC with `message`
 * provenance, and an unrecognized one yields a null date rather than dropping the
 * row. A corrupt archive, an unreadable file, a headerless file, or a malformed
 * row is reported via {@link ImportContext.onSkip} (AC-15) and never aborts.
 */

const LI_ZIP_MARKERS = ['Connections.csv', 'Rich_Media.csv', 'messages.csv'];
const LI_DIR_MARKERS = ['Connections.csv', 'Rich_Media.csv', 'messages.csv'];

type RecordDate = CatalogRecord['date'];

interface Entry {
  /** POSIX path of the entry within the archive / relative to the folder root. */
  entryPath: string;
  /** Absolute path on disk (under the scratch dir for archives; in place for folders). */
  absPath: string;
}

function isZip(inputPath: string): boolean {
  return inputPath.toLowerCase().endsWith('.zip');
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordSkip(
  ctx: ImportContext,
  skipped: SkippedItem[],
  ref: string,
  reason: string,
  code: string,
): void {
  const item: SkippedItem = { ref, reason, code };
  skipped.push(item);
  ctx.onSkip(item);
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function utcDate(ms: number): RecordDate {
  return Number.isNaN(ms) ? null : { value: new Date(ms), source: 'message' };
}

/**
 * Parse the handful of date shapes LinkedIn exports use, always as UTC. An
 * unrecognized value returns null so the row's text is still catalogued rather
 * than dropped.
 */
export function parseLinkedInDate(raw: string | null | undefined): RecordDate {
  if (raw == null) return null;
  const s = raw.trim();
  if (s === '') return null;

  // "YYYY-MM-DD[ HH:MM[:SS]] [UTC|Z]" — messages.csv / Rich_Media.csv.
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(?:UTC|Z)?$/i.exec(s);
  if (m) {
    return utcDate(
      Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0),
    );
  }

  // "DD Mon YYYY" — Connections.csv "Connected On".
  m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon !== undefined) return utcDate(Date.UTC(+m[3], mon, +m[1]));
  }

  // "Mon DD, YYYY" — some export locales.
  m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon !== undefined) return utcDate(Date.UTC(+m[3], mon, +m[2]));
  }

  // "MM/DD/YYYY" or "MM/DD/YY".
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return utcDate(Date.UTC(year, +m[1] - 1, +m[2]));
  }

  return null;
}

/** Normalize a header cell: trim, lower-case, collapse internal whitespace. */
function normHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A row accessor bound to a header→index map; reads trimmed cells by synonym. */
type RowReader = (...names: string[]) => string;

function makeRowReader(headerIndex: Map<string, number>, row: readonly string[]): RowReader {
  return (...names: string[]): string => {
    for (const name of names) {
      const idx = headerIndex.get(name);
      if (idx !== undefined) {
        const cell = row[idx];
        if (cell !== undefined) return cell.trim();
      }
    }
    return '';
  };
}

/**
 * Locate the real header row (the first whose normalized cells include any of
 * `required`) and build its name→index map, skipping any preamble before it.
 * Returns null when no header is found, so the caller can report E_PARSE.
 */
function locateHeader(
  rows: readonly string[][],
  required: readonly string[],
): { headerRow: number; index: Map<string, number> } | null {
  for (let r = 0; r < rows.length; r++) {
    const norm = rows[r].map(normHeader);
    if (required.some((name) => norm.includes(name))) {
      const index = new Map<string, number>();
      norm.forEach((name, i) => {
        if (name !== '' && !index.has(name)) index.set(name, i);
      });
      return { headerRow: r, index };
    }
  }
  return null;
}

function liRecord(fields: {
  kind: string;
  date: RecordDate;
  author: string | null;
  body: string | null;
  sourceRef: string;
  sourceMeta: Record<string, unknown>;
}): CatalogRecord {
  return {
    sourceType: 'linkedin',
    mediaType: 'message',
    originalPath: null,
    mimeType: null,
    date: fields.date,
    author: fields.author,
    body: fields.body,
    gps: null,
    durationSec: null,
    sourceRef: fields.sourceRef,
    sourceMeta: { kind: fields.kind, ...fields.sourceMeta },
  };
}

function nonEmpty(value: string): string | null {
  return value !== '' ? value : null;
}

/** Read + CSV-parse one export file, reporting E_READ / E_PARSE instead of throwing. */
async function readRows(
  entry: Entry,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<string[][] | undefined> {
  let text: string;
  try {
    text = (await ctx.deps.fs.readFile(entry.absPath)).toString('utf8');
  } catch (error) {
    recordSkip(ctx, skipped, entry.entryPath, `could not read: ${errorMessage(error)}`, 'E_READ');
    return undefined;
  }
  return parseCsv(text);
}

const MESSAGE_HEADERS = ['content', 'from', 'date', 'subject'];

function* parseMessagesFile(
  entry: Entry,
  rows: readonly string[][],
  ctx: ImportContext,
  skipped: SkippedItem[],
): Generator<CatalogRecord> {
  const header = locateHeader(rows, MESSAGE_HEADERS);
  if (header === null) {
    recordSkip(ctx, skipped, entry.entryPath, 'no recognizable LinkedIn header row', 'E_PARSE');
    return;
  }
  for (let r = header.headerRow + 1; r < rows.length; r++) {
    const read = makeRowReader(header.index, rows[r]);
    const author = read('from', 'sender');
    const body = read('content', 'message', 'body');
    const dateRaw = read('date', 'time');
    // A row with no sender, no content, and no date is malformed — report it, but
    // a row with any one of those is a memory and must be kept.
    if (author === '' && body === '' && dateRaw === '') {
      recordSkip(
        ctx,
        skipped,
        `${entry.entryPath}#${r}`,
        'row has no sender, content, or date',
        'E_PARSE',
      );
      continue;
    }
    yield liRecord({
      kind: 'message',
      date: parseLinkedInDate(dateRaw),
      author: nonEmpty(author),
      body: nonEmpty(body),
      sourceRef: `${entry.entryPath}#${r}`,
      sourceMeta: {
        subject: nonEmpty(read('subject')),
        to: nonEmpty(read('to', 'recipient')),
        conversationId: nonEmpty(read('conversation id')),
        conversationTitle: nonEmpty(read('conversation title')),
        folder: nonEmpty(read('folder')),
      },
    });
  }
}

const CONNECTION_HEADERS = ['first name', 'last name', 'connected on'];

function* parseConnectionsFile(
  entry: Entry,
  rows: readonly string[][],
  ctx: ImportContext,
  skipped: SkippedItem[],
): Generator<CatalogRecord> {
  const header = locateHeader(rows, CONNECTION_HEADERS);
  if (header === null) {
    recordSkip(ctx, skipped, entry.entryPath, 'no recognizable LinkedIn header row', 'E_PARSE');
    return;
  }
  for (let r = header.headerRow + 1; r < rows.length; r++) {
    const read = makeRowReader(header.index, rows[r]);
    const first = read('first name');
    const last = read('last name');
    const company = read('company');
    const position = read('position');
    const connectedOn = read('connected on');
    const author = `${first} ${last}`.trim();
    // A wholly empty row (e.g. a trailing blank line) carries no memory; report it.
    if (author === '' && company === '' && position === '' && connectedOn === '') {
      recordSkip(ctx, skipped, `${entry.entryPath}#${r}`, 'connection row is empty', 'E_PARSE');
      continue;
    }
    const body =
      position !== '' && company !== ''
        ? `${position} at ${company}`
        : (nonEmpty(position) ?? nonEmpty(company));
    yield liRecord({
      kind: 'connection',
      date: parseLinkedInDate(connectedOn),
      author: nonEmpty(author),
      body,
      sourceRef: `${entry.entryPath}#${r}`,
      sourceMeta: {
        firstName: nonEmpty(first),
        lastName: nonEmpty(last),
        company: nonEmpty(company),
        position: nonEmpty(position),
        profileUrl: nonEmpty(read('url', 'profile url')),
      },
    });
  }
}

const RICH_MEDIA_HEADERS = ['media link', 'link', 'media url'];

function* parseRichMediaFile(
  entry: Entry,
  rows: readonly string[][],
  ctx: ImportContext,
  skipped: SkippedItem[],
): Generator<CatalogRecord> {
  const header = locateHeader(rows, RICH_MEDIA_HEADERS);
  if (header === null) {
    recordSkip(ctx, skipped, entry.entryPath, 'no recognizable LinkedIn header row', 'E_PARSE');
    return;
  }
  for (let r = header.headerRow + 1; r < rows.length; r++) {
    const read = makeRowReader(header.index, rows[r]);
    const link = read('media link', 'link', 'media url');
    const timeRaw = read('time', 'date');
    if (link === '' && timeRaw === '') {
      recordSkip(
        ctx,
        skipped,
        `${entry.entryPath}#${r}`,
        'rich-media row has no link or time',
        'E_PARSE',
      );
      continue;
    }
    yield liRecord({
      kind: 'rich_media',
      date: parseLinkedInDate(timeRaw),
      author: null,
      body: nonEmpty(link),
      sourceRef: `${entry.entryPath}#${r}`,
      sourceMeta: { link: nonEmpty(link) },
    });
  }
}

type FileParser = (
  entry: Entry,
  rows: readonly string[][],
  ctx: ImportContext,
  skipped: SkippedItem[],
) => Iterable<CatalogRecord>;

/** Dispatch a CSV to its parser by file name; unrelated files are ignored. */
function parserFor(entryPath: string): FileParser | null {
  const name = basename(entryPath).toLowerCase();
  if (name === 'messages.csv') return parseMessagesFile;
  if (name === 'connections.csv') return parseConnectionsFile;
  if (name === 'rich_media.csv') return parseRichMediaFile;
  return null;
}

/** Depth-first file discovery over the injected fs for the folder (in-place) path. */
async function* walkFolder(
  dir: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<string> {
  if (ctx.signal.aborted) return;
  let names: readonly string[];
  try {
    names = await ctx.deps.fs.readDir(dir);
  } catch (error) {
    recordSkip(ctx, skipped, dir, `unreadable directory: ${errorMessage(error)}`, 'E_READDIR');
    return;
  }
  for (const name of names) {
    if (ctx.signal.aborted) return;
    const child = join(dir, name);
    try {
      const stat = await ctx.deps.fs.stat(child);
      if (stat.isDirectory()) {
        yield* walkFolder(child, ctx, skipped);
      } else if (stat.isFile()) {
        yield child;
      }
    } catch (error) {
      recordSkip(ctx, skipped, child, `unreadable entry: ${errorMessage(error)}`, 'E_STAT');
    }
  }
}

async function gatherEntries(
  inputPath: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<{ entries: Entry[]; discoveryFailed: boolean }> {
  if (isZip(inputPath)) {
    try {
      const extracted = await ctx.deps.extractArchive(inputPath, ctx.workDir, {
        signal: ctx.signal,
      });
      return {
        entries: extracted.map((e) => ({ entryPath: toPosix(e.entryPath), absPath: e.absPath })),
        discoveryFailed: false,
      };
    } catch (error) {
      recordSkip(
        ctx,
        skipped,
        inputPath,
        `could not extract the LinkedIn archive: ${errorMessage(error)}`,
        'E_EXTRACT',
      );
      return { entries: [], discoveryFailed: true };
    }
  }
  const entries: Entry[] = [];
  for await (const abs of walkFolder(inputPath, ctx, skipped)) {
    entries.push({ entryPath: toPosix(relative(inputPath, abs)), absPath: abs });
  }
  return { entries, discoveryFailed: false };
}

export const linkedinImporter: Importer = {
  id: 'linkedin',
  displayName: 'LinkedIn',

  async canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean> {
    try {
      if (isZip(inputPath)) {
        return await zipHasEntryName(inputPath, LI_ZIP_MARKERS);
      }
      const stat = await deps.fs.stat(inputPath);
      if (!stat.isDirectory()) return false;
      for (const marker of LI_DIR_MARKERS) {
        if (await deps.fs.exists(join(inputPath, marker))) return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  async *import(
    inputPath: string,
    ctx: ImportContext,
  ): AsyncGenerator<CatalogRecord, ImportResult> {
    const skipped: SkippedItem[] = [];
    let recordCount = 0;

    ctx.onProgress({ phase: 'discover', processed: 0, total: null, message: null });
    if (ctx.signal.aborted) {
      return { recordCount, skipped };
    }

    const { entries, discoveryFailed } = await gatherEntries(inputPath, ctx, skipped);
    if (discoveryFailed) {
      return { recordCount, skipped };
    }

    ctx.onProgress({ phase: 'parse', processed: 0, total: null, message: null });

    for (const entry of entries) {
      if (ctx.signal.aborted) return { recordCount, skipped };
      const parse = parserFor(entry.entryPath);
      if (parse === null) continue;
      const rows = await readRows(entry, ctx, skipped);
      if (rows === undefined) continue;
      for (const record of parse(entry, rows, ctx, skipped)) {
        if (ctx.signal.aborted) return { recordCount, skipped };
        recordCount += 1;
        ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
        yield record;
      }
    }

    return { recordCount, skipped };
  },
};
