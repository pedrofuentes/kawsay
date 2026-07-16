// The shared "is it exactly one?" branch behind every count-driven phrase in the
// renderer (a memory/memories tally, a collection/collections count, "N items").
// Previously computed separately, inline, wherever a count needed a word (or a
// whole verb phrase) to agree with it (#436).

/**
 * Pick `singular` when `count` is exactly 1, else `plural`. Either form can be a
 * whole phrase, not just a bare noun — e.g. `pluralize(n, 'memory is', 'memories
 * are')` — so this covers a verb agreeing with the count too.
 */
export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}
