import type { Mind } from './mind';

// The mind living each session, for the health log to report how much each one holds.
const minds = new WeakMap<object, Mind>();
export const registerMind = (session: object, mind: Mind) => minds.set(session, mind);
export const mindOf = (session: object) => minds.get(session);

// Every collection the mind and its parts hold, by path, with how many entries it has; a map of
// arrays also counts the entries inside them. What grows without bound shows up here first.
export function mindSizes(session: object): Record<string, number> | undefined {
  const mind = minds.get(session);
  if (!mind) return undefined;
  const sizes: Record<string, number> = {};
  const visit = (value: object, path: string, depth: number) => {
    for (const [key, field] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (field instanceof Map) {
        sizes[at] = field.size;
        let inner = 0;
        for (const item of field.values()) if (Array.isArray(item)) inner += item.length;
        if (inner) sizes[`${at}[]`] = inner;
      } else if (field instanceof Set) sizes[at] = field.size;
      else if (Array.isArray(field)) sizes[at] = field.length;
      else if (field && typeof field === 'object' && depth < 2 && !ArrayBuffer.isView(field))
        visit(field, at, depth + 1);
    }
  };
  visit(mind, '', 0);
  return Object.fromEntries(Object.entries(sizes).filter(([, n]) => n > 0));
}
