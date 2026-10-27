import { lasting } from './lasting';
import { info } from './log';
import { tuning } from './tuning';

// Places where walks keep going wrong, shared by every resident and kept across restarts
// (lasting.ts): no route, monsters in the way, the Help menu's stuck call. Each event is kept for
// six hours by 8-tile cell; a cell with three or more costs more to walk through for everyone
// (path-search.ts), so the population detours around a chokepoint on its own.
const CELL = 3; // 8 tiles
const HOLD_MS = tuning.trouble.holdHours * 3_600_000;
const PENALTY_AT = tuning.trouble.penaltyAt;
const events = lasting('trouble');
let cached = { at: 0, cells: [] as number[] };

export const troubleCell = (x: number, y: number) => (x >> CELL) * 1024 + (y >> CELL);

export function noteTrouble(at: { x: number; y: number }, kind: 'unreachable' | 'dangerous' | 'stuck') {
  events.set(`${at.x >> CELL},${at.y >> CELL}|${kind}|${Date.now()}`, Date.now() + HOLD_MS);
  cached.at = 0;
}

function tally() {
  const cells = new Map<string, { total: number; kinds: Map<string, number> }>();
  for (const [key, until] of events.entries()) {
    if (until <= Date.now()) continue;
    const [cell = '', kind = ''] = key.split('|');
    const entry = cells.get(cell) ?? { total: 0, kinds: new Map<string, number>() };
    cells.set(cell, entry);
    entry.total++;
    entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
  }
  return cells;
}

// The penalised cells, recomputed at most once a minute: every path search carries them.
export function troubleCells(): number[] {
  if (Date.now() - cached.at < 60_000) return cached.cells;
  const cells = [...tally()]
    .filter(([, entry]) => entry.total >= PENALTY_AT)
    .map(([cell]) => {
      const [cx = 0, cy = 0] = cell.split(',').map(Number);
      return cx * 1024 + cy;
    });
  cached = { at: Date.now(), cells };
  return cells;
}

// A line in the log for the worst places (run-session.ts, every few minutes).
export function reportTrouble() {
  const worst = [...tally()].sort(([, a], [, b]) => b.total - a.total).slice(0, 8);
  if (!worst.length) return;
  const place = (cell: string) => {
    const [cx = 0, cy = 0] = cell.split(',').map(Number);
    return `${(cx << CELL) + 4},${(cy << CELL) + 4}`;
  };
  info(
    `[trouble] ${worst.map(([cell, e]) => `${place(cell)} ×${e.total} (${[...e.kinds].map(([k, n]) => `${k} ${n}`).join(', ')})`).join('; ')}`
  );
}
