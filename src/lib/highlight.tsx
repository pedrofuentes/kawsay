// Extracted from Search.tsx (#436) — the match-highlighting used by search
// results. Everything the catalog returns is UNTRUSTED data (a loved one's
// words, captions, filenames), so this is built entirely from plain string
// slices rendered as React children: the output is always escaped text, never
// markup, so a caption like "<script>…" can never become a live element (AC-4
// posture; USER_FLOWS rubric R12).
import type { ReactNode } from 'react';

/** Wrap each case-insensitive occurrence of `term` in `<mark>`. */
export function highlight(text: string, term: string): ReactNode {
  const needle = term.trim();
  if (needle === '') return text;
  const haystack = text.toLowerCase();
  const lowered = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (;;) {
    const at = haystack.indexOf(lowered, cursor);
    if (at === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark key={key} className="rounded-sm bg-parchment-300 px-0.5 text-text-primary">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    key += 1;
    cursor = at + needle.length;
  }
  return parts;
}
