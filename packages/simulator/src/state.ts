// A mind's whole state (its snapshot) walked and changed by path: each segment a key of an object,
// an index of an array or set, or a map's key as text.

type Node = unknown;

const step = (node: Node, segment: string): Node => {
  if (node instanceof Map) return node.get(keyOf(node, segment));
  if (node instanceof Set) return [...node][Number(segment)];
  if (node && typeof node === 'object') return (node as Record<string, unknown>)[segment];
  return undefined;
};

// A map's own key for a segment: a number where its keys are numbers.
const keyOf = (map: Map<unknown, unknown>, segment: string) => {
  for (const key of map.keys()) if (String(key) === segment) return key;
  const first = map.keys().next().value;
  return typeof first === 'number' ? Number(segment) : segment;
};

export const at = (root: Node, path: readonly string[]) => path.reduce(step, root);

const kind = (value: Node) =>
  value instanceof Map
    ? 'map'
    : value instanceof Set
      ? 'set'
      : Array.isArray(value)
        ? 'array'
        : value === null
          ? 'null'
          : typeof value;

const size = (value: Node) =>
  value instanceof Map || value instanceof Set
    ? value.size
    : Array.isArray(value)
      ? value.length
      : value && typeof value === 'object'
        ? Object.keys(value).length
        : undefined;

// What lies under a path, one level: each child's key, kind, size, and its value when a leaf.
export function children(root: Node, path: readonly string[]) {
  const node = at(root, path);
  const entries: [string, Node][] =
    node instanceof Map
      ? [...node].map(([k, v]) => [String(k), v])
      : node instanceof Set
        ? [...node].map((v, i) => [String(i), v])
        : node && typeof node === 'object'
          ? Object.entries(node)
          : [];
  return entries.slice(0, 500).map(([key, value]) => {
    const n = size(value);
    return n === undefined ? { key, kind: kind(value), value } : { key, kind: kind(value), size: n };
  });
}

// Sets the value under a path; `undefined` removes it.
export function set(root: Node, path: readonly string[], value: unknown) {
  const parent = at(root, path.slice(0, -1));
  const last = path.at(-1);
  if (last === undefined) throw new Error('The whole mind cannot be replaced.');
  if (parent instanceof Map) {
    const key = keyOf(parent, last);
    if (value === undefined) parent.delete(key);
    else parent.set(key, value);
  } else if (parent instanceof Set) {
    const items = [...parent];
    items.splice(Number(last), 1, ...(value === undefined ? [] : [value]));
    parent.clear();
    for (const item of items) parent.add(item);
  } else if (parent && typeof parent === 'object') {
    if (value === undefined) delete (parent as Record<string, unknown>)[last];
    else (parent as Record<string, unknown>)[last] = value;
  } else throw new Error(`Nothing at ${path.slice(0, -1).join('.')}.`);
}
