// A value the code relies on being present (recorded state, a config file, a regex group), or a
// clear error naming what is missing instead of an undefined carried further.
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${what}.`);
  return value;
}
