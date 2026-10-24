import { type Account, type CharacterRecord, characterRecord } from './character';
import { holderKind, type Placement, placeItems } from './owners';
import { type Item, loadAccounts, loadWorld, type World } from './world';

// A world save with every item placed and every player character described, shared by the
// report, the character view and the JSON export.
export interface Analysis {
  source: string;
  world: World;
  accounts: Account[];
  residents: Set<number>;
  placements: Map<number, Placement>;
  // Items held by each mobile, by its serial.
  held: Map<number, Placement[]>;
  // Each container's (or mobile's) direct contents, by its serial.
  contents: Map<number, Item[]>;
  characters: CharacterRecord[];
}

export function analyze(saves: string): Analysis {
  const world = loadWorld(saves);
  const accounts = loadAccounts(saves);
  // AI residents log in with generated accounts (packages/ai/src/credentials.ts).
  const residents = new Set(accounts.filter((a) => a.username.startsWith('gw')).flatMap((a) => a.characters));
  const placements = placeItems(world);
  const held = new Map<number, Placement[]>();
  for (const p of placements.values()) {
    if (!p.holder) continue;
    const list = held.get(p.holder.serial) ?? [];
    held.set(p.holder.serial, list);
    list.push(p);
  }
  const contents = new Map<number, Item[]>();
  for (const item of world.items.values()) {
    if (item.parent === undefined) continue;
    const list = contents.get(item.parent) ?? [];
    contents.set(item.parent, list);
    list.push(item);
  }
  const accountOf = new Map(accounts.flatMap((a) => a.characters.map((c) => [c, a] as const)));
  const characters = [...world.mobiles.values()]
    .filter((m) => m.player)
    .map((m) => characterRecord(m, held.get(m.serial) ?? [], accountOf.get(m.serial), residents.has(m.serial)));
  return { source: saves, world, accounts, residents, placements, held, contents, characters };
}

// The whole analysis as plain data: every player character, and every item with its holder and
// place.
export function exportData(a: Analysis) {
  return {
    source: a.source,
    characters: a.characters,
    items: [...a.placements.values()].map((p) => ({
      serial: p.item.serial,
      type: p.item.type,
      name: p.item.name,
      graphic: p.item.graphic,
      hue: p.item.hue,
      amount: p.item.amount,
      place: p.place,
      holder: p.holder?.serial,
      holderName: p.holder?.name,
      holderKind: holderKind(p.holder, a.residents),
      container: p.path.map((c) => c.serial),
      where: p.where
    }))
  };
}
