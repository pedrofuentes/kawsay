import { basename, extname, join } from 'node:path';
import type { MediaType } from '@shared/catalog';
import type {
  CatalogRecord,
  ImportContext,
  Importer,
  ImporterDeps,
  ImportResult,
  MediaInfo,
  SkippedItem,
} from './types';

/**
 * Card C3 (AC-1): the WhatsApp **"Export Chat"** connector — the flagship
 * importer that brings a conversation's text, photos, voice notes / audio,
 * video, and documents into the catalogue end-to-end.
 *
 * Input is either the export **`.zip`** (extracted via the injected, zip-slip
 * guarded {@link ImporterDeps.extractArchive} — never a raw unzip) or a folder
 * the user already unpacked. The `_chat.txt` log is parsed line-by-line
 * (streaming-friendly: only the in-progress message is buffered) across the
 * locale-dependent iOS (`[DD/MM/YYYY, HH:MM:SS] Sender:`) and Android
 * (`DD/MM/YYYY, HH:MM - Sender:`) dialects, 12/24-hour clocks, and multi-line
 * continuations. Attachment markers (`<attached: file>`, `file (file
 * attached)`, `<Media omitted>`) are correlated with the co-located media and
 * classified by extension — crucially `.opus`/`.m4a` voice notes → **audio**.
 *
 * Every side effect goes through the injected, sandboxed {@link ImporterDeps}
 * so the module is unit-testable with fixtures. A malformed line or a missing
 * attachment is reported via {@link ImportContext.onSkip} (AC-15) and never
 * aborts the run; the date of each record carries `message` provenance.
 */

const CHAT_FILENAME = '_chat.txt';

// Bidirectional / formatting control marks WhatsApp sprinkles before system and
// attachment lines (notably iOS). Stripped so comparisons and matching are stable.
// Class members: U+200E/200F (LRM/RLM), U+202A–202E (embeddings/overrides),
// U+2066–2069 (isolates), U+FEFF (BOM/ZWNBSP). Written as regex literals so the
// patterns stay statically analysable (no dynamic `new RegExp`).
const LEADING_MARKS_RE = /^[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/;
const TRAILING_BLANK_RE = /[\s\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+$/u;

/**
 * One message header (`[date, time] Sender:` / `date, time - Sender:`) plus the
 * separator that precedes the body. Groups: 1 = date, 2 = time, 3 = am/pm.
 * Adapted from the unified pattern documented in research `formats.md` §1.3.
 */
const HEADER_RE =
  /^[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]*\[?(\d{1,4}[-/.]\s?\d{1,4}[-/.]\s?\d{1,4})[,.]?\s\D*?(\d{1,2}[.:]\d{1,2}(?:[.:]\d{1,2})?)(?:\s([ap]\.?\s?m\.?))?\]?(?:\s-|:)?\s/i;

interface MediaKind {
  mediaType: MediaType;
  mime: string;
}

// Extension → (MediaType, mime). Voice notes/audio (`.opus`, `.m4a`, …) classify
// as `audio` (AC-1). Mirrors the folder importer's table for shared types so a
// photo/clip catalogued from two sources reads identically. Unknown extensions
// fall back to `document` so a forwarded file is still catalogued, never dropped.
const EXT_INFO = new Map<string, MediaKind>([
  ['.jpg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.jpeg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.png', { mediaType: 'photo', mime: 'image/png' }],
  ['.gif', { mediaType: 'photo', mime: 'image/gif' }],
  ['.webp', { mediaType: 'photo', mime: 'image/webp' }],
  ['.bmp', { mediaType: 'photo', mime: 'image/bmp' }],
  ['.tif', { mediaType: 'photo', mime: 'image/tiff' }],
  ['.tiff', { mediaType: 'photo', mime: 'image/tiff' }],
  ['.heic', { mediaType: 'photo', mime: 'image/heic' }],
  ['.heif', { mediaType: 'photo', mime: 'image/heif' }],
  ['.avif', { mediaType: 'photo', mime: 'image/avif' }],
  ['.mp4', { mediaType: 'video', mime: 'video/mp4' }],
  ['.m4v', { mediaType: 'video', mime: 'video/x-m4v' }],
  ['.mov', { mediaType: 'video', mime: 'video/quicktime' }],
  ['.avi', { mediaType: 'video', mime: 'video/x-msvideo' }],
  ['.mkv', { mediaType: 'video', mime: 'video/x-matroska' }],
  ['.webm', { mediaType: 'video', mime: 'video/webm' }],
  ['.wmv', { mediaType: 'video', mime: 'video/x-ms-wmv' }],
  ['.flv', { mediaType: 'video', mime: 'video/x-flv' }],
  ['.3gp', { mediaType: 'video', mime: 'video/3gpp' }],
  ['.3gpp', { mediaType: 'video', mime: 'video/3gpp' }],
  ['.opus', { mediaType: 'audio', mime: 'audio/opus' }],
  ['.m4a', { mediaType: 'audio', mime: 'audio/mp4' }],
  ['.aac', { mediaType: 'audio', mime: 'audio/aac' }],
  ['.mp3', { mediaType: 'audio', mime: 'audio/mpeg' }],
  ['.ogg', { mediaType: 'audio', mime: 'audio/ogg' }],
  ['.oga', { mediaType: 'audio', mime: 'audio/ogg' }],
  ['.wav', { mediaType: 'audio', mime: 'audio/wav' }],
  ['.amr', { mediaType: 'audio', mime: 'audio/amr' }],
  ['.pdf', { mediaType: 'document', mime: 'application/pdf' }],
  ['.doc', { mediaType: 'document', mime: 'application/msword' }],
  [
    '.docx',
    {
      mediaType: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  ],
  ['.xls', { mediaType: 'document', mime: 'application/vnd.ms-excel' }],
  [
    '.xlsx',
    {
      mediaType: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  ],
  ['.ppt', { mediaType: 'document', mime: 'application/vnd.ms-powerpoint' }],
  [
    '.pptx',
    {
      mediaType: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  ],
  ['.txt', { mediaType: 'document', mime: 'text/plain' }],
  ['.rtf', { mediaType: 'document', mime: 'application/rtf' }],
  ['.vcf', { mediaType: 'document', mime: 'text/vcard' }],
  ['.csv', { mediaType: 'document', mime: 'text/csv' }],
]);

const FALLBACK_KIND: MediaKind = { mediaType: 'document', mime: 'application/octet-stream' };

/** Inferred order of the day/month/year components for a given chat log. */
type DateOrder = 'dmy' | 'mdy' | 'ymd';

interface PendingMessage {
  index: number;
  dateRaw: string;
  timeRaw: string;
  ampm: string | null;
  platform: 'ios' | 'android';
  author: string | null;
  bodyLines: string[];
}

interface AttachmentMatch {
  filename: string;
  caption: string;
}

// WhatsApp's Android attachment sentinel: the parenthetical it appends after the
// filename (`IMG-001.jpg (file attached)`). Matched as a COMPLETE phrase — the
// literal English marker plus the official localized equivalents WhatsApp ships
// — so an ordinary trailing parenthetical (`(each)`, `(draft)`, `(mirror)`) is
// NEVER mistaken for an attachment and the message is kept as text (🔴 #1).
// A lazy `(.+?)` filename lets a document name with its own spaces/parentheses
// (`My (final) report.pdf (file attached)`) still resolve to the real marker.
// Each entry is a specific multi-word phrase, so a false match on ordinary text
// is implausible; an unlisted locale degrades safely (kept as a text message,
// never dropped). Written as a static literal (no dynamic `new RegExp`) per this
// module's style.
const ANDROID_ATTACHMENT_RE =
  /^(.+?)\s\(\u200E?(?:file attached|archivo adjunto|arquivo anexado|ficheiro anexado|fichier joint|datei angehängt|file allegato|bestand bijgevoegd)\u200E?\)/iu;

function isZip(inputPath: string): boolean {
  return inputPath.toLowerCase().endsWith('.zip');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripLeadingMarks(text: string): string {
  return text.replace(LEADING_MARKS_RE, '');
}

/** Stable match key for an attachment filename across iOS/Android and locales. */
function normalizeName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim();
}

function classify(filename: string): MediaKind {
  return EXT_INFO.get(extname(filename).toLowerCase()) ?? FALLBACK_KIND;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Derive a human chat name from the dropped zip/folder (`WhatsApp Chat - X`). */
function deriveChatName(inputPath: string): string {
  const base = basename(inputPath).replace(/\.zip$/i, '');
  return base.replace(/^WhatsApp Chat\s*-\s*/i, '').trim() || base;
}

/**
 * Split a post-timestamp line into `author` + `body`. System notices (group
 * events, the end-to-end-encryption banner) have no `Author: ` prefix → author
 * is null. The `[<>]` guard avoids mistaking an attachment marker's inner colon
 * for an author separator on the rare sender-less media line.
 */
function splitAuthor(content: string): { author: string | null; body: string } {
  const match = /^([^:\n]{1,160}?): ([\s\S]*)$/.exec(content);
  if (match && !/[<>]/.test(match[1])) {
    return { author: match[1].trim(), body: match[2] };
  }
  return { author: null, body: content };
}

/** Detect an attachment marker at the start of a message body. */
function matchAttachment(body: string): AttachmentMatch | null {
  // iOS: "<attached: filename>" (localized verb tolerated: any "<word: name>").
  let match = /^<[^:>]*:\s*([^>]+)>/.exec(body);
  if (match) {
    return { filename: match[1].trim(), caption: body.slice(match[0].length).trim() };
  }
  // Android: "filename.ext (file attached)" — keyed on the real localized
  // sentinel only, so an ordinary "(...)" parenthetical is left as text (🔴 #1).
  match = ANDROID_ATTACHMENT_RE.exec(body);
  if (match) {
    return { filename: match[1].trim(), caption: body.slice(match[0].length).trim() };
  }
  return null;
}

/** A localized "media not exported" note (`<Media omitted>`, `imagen omitida`, …). */
function isMediaOmitted(body: string): boolean {
  const inner = body.trim().replace(/^<|>$/g, '').trim();
  return /\bomitted\b/i.test(inner) || /omitid|omitio|ocult/i.test(inner);
}

/**
 * Infer day/month/year order once per log: a 4-digit leading field ⇒ year-first;
 * a first field > 12 ⇒ day-first; a second field > 12 ⇒ month-first; otherwise
 * default to the globally common day-first (research `formats.md` §1.3, §1.8).
 */
function inferDateOrder(lines: readonly string[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  let ymd = 0;
  for (const line of lines) {
    const match = HEADER_RE.exec(line.replace(/\r$/, ''));
    if (!match) continue;
    const parts = match[1].split(/[-/.]/).map((value) => value.trim());
    if (parts.length !== 3) continue;
    if (parts[0].length === 4) {
      ymd += 1;
      continue;
    }
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    if (first > 12 && second <= 12) dmy += 1;
    else if (second > 12 && first <= 12) mdy += 1;
  }
  if (ymd > dmy + mdy) return 'ymd';
  if (mdy > dmy) return 'mdy';
  return 'dmy';
}

function parseTime(timeRaw: string, ampm: string | null): { h: number; m: number; s: number } {
  const parts = timeRaw.split(/[.:]/).map(Number);
  let h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const s = parts[2] ?? 0;
  if (ampm) {
    if (/p/i.test(ampm) && h < 12) h += 12;
    else if (/a/i.test(ampm) && h === 12) h = 0;
  }
  return { h, m, s };
}

/**
 * Build the message timestamp. WhatsApp records a local wall-clock time with no
 * zone; following the ARCHITECTURE §3.2 convention (the same one EXIF dates use)
 * it is interpreted as UTC so the timeline sort is deterministic and tests are
 * timezone-independent.
 */
function buildDate(
  dateRaw: string,
  timeRaw: string,
  ampm: string | null,
  order: DateOrder,
): CatalogRecord['date'] {
  const parts = dateRaw.split(/[-/.]/).map((value) => Number(value.trim()));
  if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {
    return null;
  }
  let day: number;
  let month: number;
  let year: number;
  if (order === 'ymd') [year, month, day] = parts;
  else if (order === 'mdy') [month, day, year] = parts;
  else [day, month, year] = parts;
  if (year < 100) year += 2000;
  const { h, m, s } = parseTime(timeRaw, ampm);
  const ms = Date.UTC(year, month - 1, day, h, m, s);
  return Number.isNaN(ms) ? null : { value: new Date(ms), source: 'message' };
}

async function probeSafe(deps: ImporterDeps, absPath: string): Promise<MediaInfo | null> {
  try {
    return await deps.probeMedia(absPath);
  } catch {
    return null;
  }
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

interface ChatSource {
  chatAbsPath: string | null;
  attachments: Map<string, string>;
  /**
   * A hard discovery failure (e.g. a corrupt / locked / unreadable archive)
   * that has already been reported via {@link ImportContext.onSkip}. The caller
   * returns its partial result instead of re-reporting it as a missing chat.
   */
  discoveryFailed: boolean;
}

/** Locate `_chat.txt` and map every co-located media file by its (normalized) name. */
async function gather(
  inputPath: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<ChatSource> {
  const attachments = new Map<string, string>();
  let chatAbsPath: string | null = null;

  if (isZip(inputPath)) {
    try {
      const entries = await ctx.deps.extractArchive(inputPath, ctx.workDir, { signal: ctx.signal });
      for (const entry of entries) {
        const name = basename(entry.entryPath);
        if (name === CHAT_FILENAME) chatAbsPath = entry.absPath;
        else attachments.set(normalizeName(name), entry.absPath);
      }
    } catch (error) {
      // AC-15: a corrupt / locked / unreadable archive is reported and the run
      // returns its partial result — it never throws out to abort the import.
      recordSkip(
        ctx,
        skipped,
        inputPath,
        `could not extract the WhatsApp archive: ${errorMessage(error)}`,
        'E_EXTRACT',
      );
      return { chatAbsPath: null, attachments, discoveryFailed: true };
    }
  } else {
    for await (const absPath of walkFolder(inputPath, ctx, skipped)) {
      const name = basename(absPath);
      if (name === CHAT_FILENAME) chatAbsPath = absPath;
      else attachments.set(normalizeName(name), absPath);
    }
  }
  return { chatAbsPath, attachments, discoveryFailed: false };
}

interface MessageOutput {
  record: CatalogRecord | null;
  skip: SkippedItem | null;
}

/** Normalize one assembled message into a catalog record (or a skip). */
async function normalizeMessage(
  message: PendingMessage,
  attachments: Map<string, string>,
  order: DateOrder,
  chatName: string,
  deps: ImporterDeps,
): Promise<MessageOutput> {
  const date = buildDate(message.dateRaw, message.timeRaw, message.ampm, order);
  const baseMeta: Record<string, unknown> = {
    chatName,
    platform: message.platform,
    rawTimestamp: `${message.dateRaw} ${message.timeRaw}${message.ampm ? ` ${message.ampm}` : ''}`,
  };

  const assembled = message.bodyLines.join('\n').replace(TRAILING_BLANK_RE, '');
  const body = stripLeadingMarks(assembled);

  const attachment = matchAttachment(body);
  if (attachment) {
    const absPath = attachments.get(normalizeName(attachment.filename)) ?? null;
    if (!absPath) {
      return {
        record: null,
        skip: {
          ref: attachment.filename,
          reason: 'referenced attachment is missing from the export',
          code: 'E_MISSING_ATTACHMENT',
        },
      };
    }
    const kind = classify(attachment.filename);
    const probed =
      kind.mediaType === 'audio' || kind.mediaType === 'video'
        ? await probeSafe(deps, absPath)
        : null;
    return {
      record: {
        sourceType: 'whatsapp',
        mediaType: kind.mediaType,
        originalPath: absPath,
        mimeType: probed?.mimeType ?? kind.mime,
        date,
        author: message.author,
        body: attachment.caption.length > 0 ? attachment.caption : null,
        gps: null,
        durationSec: probed?.durationSec ?? null,
        sourceRef: `att:${attachment.filename}`,
        sourceMeta: { ...baseMeta, system: false, attachmentFileName: attachment.filename },
      },
      skip: null,
    };
  }

  const mediaOmitted = isMediaOmitted(body);
  return {
    record: {
      sourceType: 'whatsapp',
      mediaType: 'message',
      originalPath: null,
      mimeType: null,
      date,
      author: message.author,
      body: body.length > 0 ? body : null,
      gps: null,
      durationSec: null,
      sourceRef: `msg:${message.index}`,
      sourceMeta: {
        ...baseMeta,
        system: message.author === null,
        ...(mediaOmitted ? { mediaOmitted: true } : {}),
      },
    },
    skip: null,
  };
}

export const whatsappImporter: Importer = {
  id: 'whatsapp',
  displayName: 'WhatsApp',

  async canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean> {
    try {
      if (isZip(inputPath)) {
        // The zip's central directory stores entry names verbatim, so a byte
        // scan for the marker recognizes a chat export without extracting.
        const buffer = await deps.fs.readFile(inputPath);
        return buffer.includes(CHAT_FILENAME);
      }
      const stat = await deps.fs.stat(inputPath);
      if (stat.isDirectory()) {
        return await deps.fs.exists(join(inputPath, CHAT_FILENAME));
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

    const { chatAbsPath, attachments, discoveryFailed } = await gather(inputPath, ctx, skipped);
    if (discoveryFailed) {
      // The archive could not be opened; the skip is already recorded (AC-15).
      return { recordCount, skipped };
    }
    if (!chatAbsPath) {
      recordSkip(ctx, skipped, CHAT_FILENAME, 'no _chat.txt found in WhatsApp export', 'E_NO_CHAT');
      return { recordCount, skipped };
    }

    let text: string;
    try {
      text = stripBom((await ctx.deps.fs.readFile(chatAbsPath)).toString('utf8'));
    } catch (error) {
      // AC-15: an unreadable _chat.txt is reported, not thrown — the run returns
      // its partial result (any records emitted so far are preserved).
      recordSkip(
        ctx,
        skipped,
        chatAbsPath,
        `could not read ${CHAT_FILENAME}: ${errorMessage(error)}`,
        'E_READ_CHAT',
      );
      return { recordCount, skipped };
    }
    ctx.onProgress({ phase: 'parse', processed: 0, total: null, message: null });

    const lines = text.split('\n');
    const order = inferDateOrder(lines);
    const chatName = deriveChatName(inputPath);

    let pending: PendingMessage | null = null;
    let msgIndex = -1;

    // Flush a completed message: yield its record (or report its skip) and tick
    // progress/count. `recordCount`/`skipped` are closed over and mutated here.
    async function* flush(message: PendingMessage): AsyncGenerator<CatalogRecord> {
      const { record, skip } = await normalizeMessage(
        message,
        attachments,
        order,
        chatName,
        ctx.deps,
      );
      if (skip) {
        skipped.push(skip);
        ctx.onSkip(skip);
      }
      if (record) {
        recordCount += 1;
        ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
        yield record;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      if (ctx.signal.aborted) {
        pending = null;
        break;
      }
      const raw = lines[i].replace(/\r$/, '');
      const header = HEADER_RE.exec(raw);
      if (header) {
        if (pending) {
          yield* flush(pending);
        }
        msgIndex += 1;
        const platform = stripLeadingMarks(raw).startsWith('[') ? 'ios' : 'android';
        const { author, body } = splitAuthor(stripLeadingMarks(raw.slice(header[0].length)));
        pending = {
          index: msgIndex,
          dateRaw: header[1],
          timeRaw: header[2],
          ampm: header[3] ?? null,
          platform,
          author,
          bodyLines: [body],
        };
      } else if (pending) {
        pending.bodyLines.push(raw);
      } else if (raw.trim() !== '') {
        recordSkip(
          ctx,
          skipped,
          `line:${i + 1}`,
          'unparseable line before first message',
          'E_PARSE',
        );
      }
    }
    if (pending && !ctx.signal.aborted) {
      yield* flush(pending);
    }

    return { recordCount, skipped };
  },
};
