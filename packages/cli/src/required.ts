export function required<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${what}.`);
  return value;
}
