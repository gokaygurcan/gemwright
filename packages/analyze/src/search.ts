import type { Analysis } from './analysis';
import { itemLabel } from './owners';

// Search over a save's mobiles and items by name, script type or serial (decimal or 0x hex).
export interface Hit {
  kind: 'character' | 'mobile' | 'item';
  serial: number;
  label: string;
  detail: string;
}

const typeName = (type: string) => type.replace(/^Server\.(Items|Mobiles|Multis)\./, '');
const hex = (serial: number) => `0x${serial.toString(16)}`;

export function search(a: Analysis, query: string, limit = 50): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const serial = /^0x[0-9a-f]+$/.test(q) ? Number.parseInt(q, 16) : /^\d+$/.test(q) ? Number(q) : undefined;
  const hits: Hit[] = [];
  const mobile = (serial: number) => {
    const m = a.world.mobiles.get(serial);
    return m
      ? [
          {
            kind: m.player ? 'character' : 'mobile',
            serial,
            label: m.name ?? typeName(m.type),
            detail: typeName(m.type)
          } as Hit
        ]
      : [];
  };
  const item = (serial: number) => {
    const i = a.world.items.get(serial);
    const holder = a.placements.get(serial)?.holder;
    return i
      ? [
          {
            kind: 'item',
            serial,
            label: itemLabel(i),
            detail: holder ? `held by ${holder.name ?? holder.serial}` : ''
          } as Hit
        ]
      : [];
  };
  if (serial !== undefined) return [...mobile(serial), ...item(serial)];
  // Characters first, then other mobiles, then items; each by name before script type.
  for (const players of [true, false])
    for (const m of a.world.mobiles.values()) {
      if (m.player !== players || hits.length >= limit) continue;
      if (m.name?.toLowerCase().includes(q) || typeName(m.type).toLowerCase().includes(q))
        hits.push(...mobile(m.serial));
    }
  for (const i of a.world.items.values()) {
    if (hits.length >= limit * 2) break;
    if (itemLabel(i).toLowerCase().includes(q) || typeName(i.type).toLowerCase().includes(q))
      hits.push(...item(i.serial));
  }
  return hits.map((h) => ({ ...h, detail: h.detail || hex(h.serial) }));
}
