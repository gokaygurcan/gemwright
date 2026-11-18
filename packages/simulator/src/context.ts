// What a mind is asked while it weighs: every question options and planning put to it (its
// methods and getters, and those of its self), each with the answer it gave. A pinned question is
// answered with the pinned value instead, whoever asks it.

export interface Read {
  key: string;
  name: string;
  value: unknown;
  calls: number;
  pinned: boolean;
}

// What it does rather than answers: never asked while weighing, never wrapped.
const doing = new Set([
  'constructor',
  'observe',
  'snapshot',
  'restore',
  'complete',
  'exhausted',
  'notice',
  'refuseDrop',
  'refuseSpell',
  'deposit',
  'write',
  'act',
  'finish',
  'drift',
  'wake',
  'lift'
]);

const brief = (value: unknown) => {
  if (typeof value === 'function') return 'fn';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

const iterator = (value: unknown): value is IterableIterator<unknown> =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Iterator<unknown>).next === 'function' &&
  Symbol.iterator in value;

// Answers as the page shows them: maps as objects, sets as arrays, long lists cut.
export function plain(value: unknown, depth = 6): unknown {
  if (value instanceof Map) return plain(Object.fromEntries([...value].map(([k, v]) => [String(k), v])), depth);
  if (value instanceof Set) return plain([...value], depth);
  if (typeof value === 'function') return 'fn';
  if (!value || typeof value !== 'object') return value;
  if (depth === 0) return Array.isArray(value) ? `[${value.length}]` : '{…}';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => plain(v, depth - 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v, depth - 1)]));
}

function members(target: object) {
  const found = new Map<string, PropertyDescriptor>();
  for (let proto = target; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    for (const name of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || doing.has(name) || found.has(name)) continue;
      if (descriptor.get || typeof descriptor.value === 'function') found.set(name, descriptor);
    }
  return found;
}

// Wraps the targets' questions until the returned function is called. Only questions asked from
// outside (not by the mind of itself) are recorded; pins answer at any depth.
export function listen(
  targets: [prefix: string, target: object][],
  pins: ReadonlyMap<string, unknown>,
  reads: Map<string, Read>
) {
  let depth = 0;
  const ask = (key: string, name: string, answer: () => unknown) => {
    const pinned = pins.has(key);
    let value: unknown;
    depth++;
    try {
      value = pinned ? pins.get(key) : answer();
      if (iterator(value)) value = [...value];
    } finally {
      depth--;
    }
    if (depth === 0) {
      const read = reads.get(key);
      if (read) read.calls++;
      else reads.set(key, { key, name, value, calls: 1, pinned });
    }
    return value;
  };
  const undo: (() => void)[] = [];
  for (const [prefix, target] of targets)
    for (const [name, descriptor] of members(target)) {
      const own = Object.getOwnPropertyDescriptor(target, name);
      const label = `${prefix}${name}`;
      if (descriptor.get) {
        const get = descriptor.get;
        Object.defineProperty(target, name, {
          configurable: true,
          get() {
            return ask(label, label, () => get.call(this));
          }
        });
      } else {
        const fn = descriptor.value as (...args: unknown[]) => unknown;
        Object.defineProperty(target, name, {
          configurable: true,
          writable: true,
          value(this: object, ...args: unknown[]) {
            return ask(`${label}(${args.map(brief).join(', ')})`, label, () => fn.apply(this, args));
          }
        });
      }
      undo.push(() => {
        if (own) Object.defineProperty(target, name, own);
        else delete (target as Record<string, unknown>)[name];
      });
    }
  return () => {
    for (const step of undo.reverse()) step();
  };
}
