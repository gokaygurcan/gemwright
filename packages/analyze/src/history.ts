import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Analysis } from './analysis';
import { type Block, type Doc, num } from './doc';
import type { ResidentRow } from './residents';

// One line per pull in <pulls>/history.jsonl, written when the browser reads a pull, so a
// deploy's effect shows as a trend instead of a guess from half an hour of logs.
export interface Snapshot {
  pull: string;
  at: string;
  residents: number;
  deaths: number;
  stranded: number;
  sideTrade: number;
  robes: number;
  trades: Record<string, { n: number; gold: number; skills: number }>;
}

const historyFile = (saves: string) => join(dirname(dirname(dirname(saves))), 'history.jsonl');

export function readHistory(saves: string): Snapshot[] {
  const file = historyFile(saves);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Snapshot);
}

// Adds this pull to the history unless it is there already. Only pulls (with a resident database).
export function recordHistory(saves: string, a: Analysis, rows: ResidentRow[] | undefined, savedAt?: Date) {
  if (!rows) return;
  const pull = basename(dirname(dirname(saves)));
  if (readHistory(saves).some((s) => s.pull === pull)) return;
  const bySerial = new Map(a.characters.map((c) => [c.serial, c]));
  const trades: Snapshot['trades'] = {};
  for (const r of rows) {
    const c = bySerial.get(r.serial);
    const t = trades[r.trade] ?? { n: 0, gold: 0, skills: 0 };
    trades[r.trade] = t;
    t.n++;
    t.gold += (c?.gold.carried ?? 0) + r.bank;
    t.skills += c?.skillTotal ?? 0;
  }
  for (const t of Object.values(trades)) {
    t.gold = Math.round(t.gold / t.n);
    t.skills = Math.round((t.skills / t.n) * 10) / 10;
  }
  const residents = new Set(rows.map((r) => r.serial));
  const packs = new Map<number, number>();
  for (const m of a.world.mobiles.values())
    if (residents.has(m.serial))
      for (const s of m.items) if (a.world.items.get(s)?.layer === 21) packs.set(s, m.serial);
  const holder = (parent?: number) => {
    for (let depth = 0; parent !== undefined && depth < 4; depth++) {
      if (packs.has(parent)) return true;
      parent = a.world.items.get(parent)?.parent;
    }
    return false;
  };
  const robes = [...a.world.items.values()].filter((i) => i.type.endsWith('DeathRobe') && holder(i.parent)).length;
  const snapshot: Snapshot = {
    pull,
    at: (savedAt ?? new Date()).toISOString(),
    residents: rows.length,
    deaths: rows.reduce((n, r) => n + r.deaths, 0),
    stranded: rows.reduce((n, r) => n + r.stranded, 0),
    sideTrade: rows.filter((r) => r.sideTrade).length,
    robes,
    trades
  };
  appendFileSync(historyFile(saves), `${JSON.stringify(snapshot)}\n`);
}

export function historyDoc(history: Snapshot[]): Doc {
  if (!history.length)
    return { title: 'History', blocks: [{ kind: 'note', text: 'No pulls with a resident database yet.' }] };
  const sorted = [...history].sort((a, b) => a.at.localeCompare(b.at));
  const trades = [...new Set(sorted.flatMap((s) => Object.keys(s.trades)))].sort();
  const byTrade = (key: 'gold' | 'skills'): Block => ({
    kind: 'table',
    head: ['Trade', ...sorted.map((s) => s.at.slice(5, 16).replace('T', ' '))],
    numeric: sorted.map((_, i) => i + 1),
    rows: trades.map((t) => [
      t,
      ...sorted.map((s) => (s.trades[t] ? num(s.trades[t][key], key === 'skills' ? 1 : 0) : ''))
    ])
  });
  return {
    title: 'History',
    subtitle: ['One row per pull (UTC). Deaths and strandings are the last six hours before the pull.'],
    blocks: [
      {
        kind: 'table',
        head: ['Pull', 'Residents', 'Deaths', 'Stranded', 'Side trade', 'Death robes'],
        numeric: [1, 2, 3, 4, 5],
        rows: sorted.map((s) => [
          s.at.slice(0, 16).replace('T', ' '),
          num(s.residents),
          num(s.deaths),
          num(s.stranded),
          num(s.sideTrade),
          num(s.robes)
        ])
      },
      { kind: 'heading', text: 'Average gold per resident' },
      byTrade('gold'),
      { kind: 'heading', text: 'Average skill total' },
      byTrade('skills')
    ]
  };
}
