// Timers that must outlive a restart: where a walk failed, where monsters were seen, which escort
// refused, recent deaths. Each entry is a key and the time it expires. The runtime loads them from
// the resident database when it starts and saves them every few minutes and when it stops
// (run-session.ts), so a redeploy does not send every resident back into the same trouble.
const tables = new Map<string, Map<string, number>>();
const LIMIT = 20_000;

const table = (name: string) => {
  const found = tables.get(name) ?? new Map<string, number>();
  tables.set(name, found);
  return found;
};

// One resident's share of a table (`scope` is its serial), or the whole table when shared.
export function lasting(name: string, scope?: number) {
  const entries = table(name);
  const prefix = scope === undefined ? '' : `${scope}|`;
  return {
    get: (key: string | number) => entries.get(prefix + key),
    active: (key: string | number) => (entries.get(prefix + key) ?? 0) > Date.now(),
    set: (key: string | number, until: number) => {
      if (entries.size > LIMIT) prune(entries);
      entries.set(prefix + key, until);
    },
    entries: () => entries.entries(),
    // Entries of this scope still running: the recent-history tables count them.
    count: () => {
      let n = 0;
      for (const [key, until] of entries) if (key.startsWith(prefix) && until > Date.now()) n++;
      return n;
    }
  };
}

function prune(entries: Map<string, number>) {
  const now = Date.now();
  for (const [key, until] of entries) if (until <= now) entries.delete(key);
}

export function loadLasting(json: string | null) {
  if (!json) return;
  try {
    const now = Date.now();
    for (const [name, rows] of Object.entries(JSON.parse(json) as Record<string, [string, number][]>))
      for (const [key, until] of rows) if (until > now) table(name).set(key, until);
  } catch {
    // A damaged copy is dropped: the timers start empty, as they did before they were kept.
  }
}

export function saveLasting() {
  const out: Record<string, [string, number][]> = {};
  for (const [name, entries] of tables) {
    prune(entries);
    out[name] = [...entries];
  }
  return JSON.stringify(out);
}
