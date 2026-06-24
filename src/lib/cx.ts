// Tiny class-name joiner. Keeps component markup readable while letting us drop
// falsy branches (e.g. `isActive && 'bg-sage-600'`) inline.
export type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}
