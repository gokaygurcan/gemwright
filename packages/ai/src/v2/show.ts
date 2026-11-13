import { describePlace } from './atlas';
import type { Mind } from './mind';
import type { Narrator } from './narrate';

export function shower(mind: Mind, narrator: Narrator, record: (kind: string, data: object) => void) {
  // What it knows of where it is, what it is and what it has, written down whenever it changes
  // (analyze's minds page reads them), and said over its head when the shard's debugging is on:
  // where it has come to, what it can newly do, and a find it values (as much as its greed makes it).
  let shown = { place: '', abilities: '', holding: '', worth: Number.NaN };
  return () => {
    const place = mind.here ? describePlace(mind.here) : '';
    if (place && place !== shown.place) narrator.tell(place);
    const can = mind.self.abilities();
    const growth = mind.self.growth();
    const abilities = JSON.stringify({
      skills: Object.fromEntries(mind.self.skills),
      stats: mind.self.stats,
      statLocks: mind.self.statLocks,
      statCap: mind.self.statCap,
      weapons: can.weapons,
      crafts: can.crafts,
      parry: can.parry,
      tames: can.tames.map((c) => c.name),
      carries: can.carries,
      growth
    });
    if (shown.abilities && abilities !== shown.abilities) {
      const before = JSON.parse(shown.abilities) as { tames: string[] };
      const tames = can.tames.map((c) => c.name).filter((name) => !before.tames.includes(name));
      if (tames.length) narrator.tell(`can tame ${tames.slice(0, 3).join(', ')} now`);
    }
    if (abilities !== shown.abilities) record('abilities', JSON.parse(abilities) as object);
    const has = mind.has();
    const sum = (items: readonly { kind: string; amount: number; worth: number; weight?: number }[]) =>
      items.reduce<Record<string, { amount: number; worth: number; weight: number }>>((by, item) => {
        const kind = by[item.kind] ?? { amount: 0, worth: 0, weight: 0 };
        by[item.kind] = kind;
        kind.amount += item.amount;
        kind.worth += item.worth;
        kind.weight += item.weight ?? 0;
        return by;
      }, {});
    const holding = JSON.stringify({
      worn: sum(has.worn),
      pack: sum(has.pack),
      bank: sum(has.bank),
      ground: has.ground.length,
      corpses: has.corpses.length
    });
    if (holding !== shown.holding) record('holding', JSON.parse(holding) as object);
    const worth = [...has.worn, ...has.pack, ...has.bank].reduce((total, item) => total + item.worth, 0);
    const found = worth - shown.worth;
    if (found > 0 && found * mind.temper.greed >= Math.max(1, mind.funds()) * (1 - mind.temper.greed))
      narrator.tell(`found something worth ${Math.round(found)} gold`);
    shown = { place, abilities, holding, worth };
  };
}
