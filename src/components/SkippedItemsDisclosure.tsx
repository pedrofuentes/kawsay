// The "would you like to see which ones?" reveal for skipped import items
// (#430, AC-15, P4b "never silently drop items"). An import summary previously
// surfaced skips only as an aggregate count — this makes every one of them
// inspectable: a single labelled toggle that expands into a list of each
// skipped file's name plus a plain-language, reverent reason (P1 — no jargon
// like "parse" or "metadata"), mapped from the importer's `code`. Deliberately
// standalone (not baked into ImportStep) so the same disclosure can back the
// future Add Memories view (#427) without duplicating the copy or the a11y
// wiring.
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { SkippedItemDTO } from '@shared/kawsay-api';
import { Icon } from './Icon';

/**
 * Plain-language, reverent copy for every `SkippedItemDTO.code` the importers
 * report today (folder, WhatsApp, Telegram, iMessage, Facebook, LinkedIn, the
 * Meta "Download Your Information" connector, Takeout, and the shared ingest
 * pipeline). Grouped by what actually happened, never by the internal code —
 * the reader never sees "parse", "metadata", a MIME type, or a raw error.
 */
const SKIP_REASON_BY_CODE: Record<string, string> = {
  // Reading a folder or an individual entry's basic info.
  E_READDIR: "We couldn't open a folder in the export.",
  E_STAT: "We couldn't read this item's basic information.",
  E_EXTRACT: "We couldn't unpack part of the export.",

  // Brought in, but a detail could not be read (not a full skip).
  E_EXIF: "We brought this one in, but couldn't read all of its details, like when it was taken.",
  E_PROBE: "We brought this one in, but couldn't read its technical details.",

  // Conversation / message files.
  E_NO_CHAT: "We couldn't find the conversation file in this export.",
  E_READ_CHAT: "We couldn't read the conversation file.",
  E_PARSE: "This entry wasn't in a format we could read.",
  E_PARSE_MSG: "This message wasn't in a format we could read.",
  E_PARSE_MESSAGE: "This message wasn't in a format we could read.",
  E_READ_MBOX: "We couldn't read part of the mail export.",
  E_MBOX_MESSAGE_TOO_LARGE: 'This message was too large for us to bring in.',
  E_MESSAGE_TOO_LARGE: 'This message was too large for us to bring in.',
  E_MESSAGE_TOO_DEEP: "This message's structure was too complex for us to read.",
  E_READ_JSON: "We couldn't read part of the export file.",
  E_EMPTY_MESSAGE: 'This message had no content to bring in.',
  E_SERVICE_MESSAGE: 'This was a system notice rather than a memory, so we left it out.',
  E_OPEN_DB: "We couldn't open the messages file.",
  E_READ_DB: "We couldn't read from the messages file.",

  // Attached / referenced media.
  E_MISSING_ATTACHMENT: "An attached file mentioned in the conversation wasn't in the export.",
  E_MEDIA_PATH: "The attached file's location looked unsafe, so we left it out.",
  E_ATTACHMENT_PATH: "The attached file's location looked unsafe, so we left it out.",
  E_MEDIA_TYPE: "This attached file's type isn't one we support yet.",
  E_ATTACHMENT_TYPE: "This attached file's type isn't one we support yet.",
  E_MEDIA_FILE: "The attached file wasn't actually there.",
  E_ATTACHMENT_FILE: "The attached file wasn't actually there.",
  E_MEDIA_MISSING: 'The attached file was missing from the export.',
  E_ATTACHMENT_MISSING: 'The attached file was missing from the export.',
  E_MISSING_MEDIA: 'A photo or file mentioned in the export was missing.',
  E_MEDIA_URI: "This entry didn't reference an attached file.",
  E_WRITE_ATTACH: "We couldn't save an attached file from this message.",
  E_SIDECAR: "We couldn't read the details file that goes with this item.",

  // Export-wide safety limits.
  E_DIR_TOO_DEEP: "The export's folders were nested deeper than we could safely follow.",
  E_ENTRY_LIMIT: 'The export had more entries than we could safely process.',

  // Generic file reads and the shared ingest pipeline.
  E_READ: "We couldn't read this file.",
  E_HASH: "We couldn't read this file to bring it in safely.",
  E_ORIGINAL_STORE: "We couldn't save a copy of this file.",
};

/** A calm, reverent fallback for a code we don't recognize yet — never a raw
 *  code and never silence (P4b, P1). */
const FALLBACK_REASON = "We couldn't bring this one in — everything else came through safely.";

function describeSkip(code: string | undefined): string {
  if (code === undefined) {
    return FALLBACK_REASON;
  }
  return SKIP_REASON_BY_CODE[code] ?? FALLBACK_REASON;
}

/** The last path segment, tolerant of both `/` and `\` separators — a skip's
 *  `ref` may be a nested relative path (e.g. an archive entry). */
function filenameOf(ref: string): string {
  const segments = ref.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : ref;
}

export interface SkippedItemsDisclosureProps {
  items: readonly SkippedItemDTO[];
}

/**
 * "See which ones?" — a labelled, keyboard-accessible disclosure that lists
 * every skipped item with its filename and a plain-language reason. Renders
 * NOTHING for a zero-skip import, so a clean run stays exactly as calm as
 * before.
 */
export function SkippedItemsDisclosure({ items }: SkippedItemsDisclosureProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const listId = useId();

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-fit items-center gap-1.5 rounded-lg px-2 font-body text-base font-medium text-sage-600 underline decoration-sage-300 underline-offset-4"
      >
        See which ones?
        <Icon
          name="arrow-right"
          className={open ? 'h-4 w-4 rotate-90 transition-transform' : 'h-4 w-4 transition-transform'}
        />
      </button>
      <ul id={listId} hidden={!open} className="flex flex-col gap-2">
        {items.map((item, index) => (
          <li
            // A skip's `ref` is not guaranteed unique (e.g. two archive entries
            // can share a name after a failed extract), so the index anchors the key.
            key={`${item.ref}-${index}`}
            className="flex flex-col gap-0.5 rounded-lg bg-surface-sunken px-3 py-2"
          >
            <span className="font-body text-sm font-medium text-text-primary break-all">
              {filenameOf(item.ref)}
            </span>
            <span className="font-body text-sm text-text-secondary">{describeSkip(item.code)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
