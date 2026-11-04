import { smeltingForges } from '@gemwright/common/game/rules';

// ServUO decoration files (Data/Decoration/**/*.cfg, what `[decorate` places): blocks of a type line
// (`Type 0xGRAPHIC`, with any `(Property=value)` after it) followed by one `x y z` line per placement.
export interface Placement {
  type: string;
  graphic: number;
  x: number;
  y: number;
  z: number;
}

export function parseDecoration(text: string): Placement[] {
  const placements: Placement[] = [];
  let type = '';
  let graphic = -1;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      graphic = -1;
      continue;
    }
    const point = /^(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(line);
    if (point && graphic >= 0) {
      placements.push({ type, graphic, x: Number(point[1]), y: Number(point[2]), z: Number(point[3]) });
      continue;
    }
    const header = /^(\S+)\s+(0x[0-9a-f]+)\b/i.exec(line);
    if (header) {
      type = header[1] ?? '';
      graphic = Number.parseInt(header[2] ?? '', 16);
    }
  }
  return placements;
}

// A public forge ore smelts at (Ore.cs IsForge).
export const isForge = (graphic: number) => smeltingForges.has(graphic);
// A resurrection ankh a ghost can use (Ankhs.cs AnkhWest and AnkhNorth, plain or bloodied).
export const isAnkh = (type: string) => /^(Bloody)?Ankh(West|North)$/i.test(type);
