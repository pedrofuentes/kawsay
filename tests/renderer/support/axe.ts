// Holistic accessibility assertion for the renderer suites (AC-13). Runs the
// dev-only axe-core engine over a rendered container and fails on any WCAG 2.1
// A/AA violation — the exact bar PRD §4 AC-13 sets ("no serious/critical axe
// violations", verified against WCAG 2.1 AA). axe-core is a devDependency only
// (ADR-0017); it ships in no production bundle and opens no network.
//
// Note on contrast: axe cannot compute colour-contrast under jsdom (there is no
// real layout/canvas), so it reports those as "incomplete", never "violations".
// Token-pair contrast is verified separately against the USER_FLOWS §6.1 table
// (and asserted at the class/token level, e.g. the placeholder-contrast test).
import axe from 'axe-core';
import { expect } from 'vitest';

/** WCAG 2.1 Level A + AA — the precise standard AC-13 names. */
const WCAG_21_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/**
 * Assert a rendered container has zero WCAG 2.1 A/AA axe violations.
 * On failure the thrown message lists each rule, its impact, and the offending
 * nodes so the gap is actionable without re-running axe by hand.
 */
export async function expectNoAxeViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: [...WCAG_21_AA_TAGS] },
    resultTypes: ['violations'],
  });

  const summary = results.violations
    .map(
      (violation) =>
        `${violation.impact ?? 'n/a'} · ${violation.id}: ${violation.help}\n    ` +
        violation.nodes.map((node) => node.target.join(' ')).join('\n    '),
    )
    .join('\n');

  expect(results.violations, summary || 'expected no WCAG 2.1 AA axe violations').toEqual([]);
}
