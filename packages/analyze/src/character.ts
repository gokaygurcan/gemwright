import { gold } from '@gemwright/common/items';
import { MAPS } from '@gemwright/common/maps';
import { skillLabel } from '@gemwright/common/skills';

import { table, tenths } from './markdown';
import { itemLabel, type Placement } from './owners';
import type { Mobile } from './world';

// One character in full: account, stats, every skill with its cap and lock, gold, and every item
// it holds with where it is (worn, backpack, bank, mount) and the containers around it.
export interface Account {
  username: string;
  characters: number[];
  gold: number;
}

const LOCKS = ['up', 'down', 'locked'];

export function characterRecord(m: Mobile, held: Placement[], account: Account | undefined, resident: boolean) {
  const coins = (where: (p: Placement) => boolean) =>
    held.filter((p) => p.item.graphic === gold && where(p)).reduce((n, p) => n + p.item.amount, 0);
  const checks = held.filter((p) => p.item.worth !== undefined);
  return {
    serial: m.serial,
    name: m.name ?? '?',
    account: account?.username,
    resident,
    online: m.online,
    created: m.created.toISOString(),
    location: { map: MAPS[m.map] ?? String(m.map), ...m.location },
    stats: { str: m.str, dex: m.dex, int: m.int, hits: m.hits },
    fame: m.fame,
    karma: m.karma,
    kills: m.kills,
    deaths: m.deaths,
    skillTotal: m.skills.reduce((n, v) => n + v, 0) / 10,
    skillCap: m.skillCap / 10,
    // How many skills are set down or locked; the untrained ones are left out of `skills`.
    locks: { down: m.locks.filter((l) => l === 1).length, locked: m.locks.filter((l) => l === 2).length },
    skills: m.skills
      .map((value, id) => ({
        skill: skillLabel(id),
        value: value / 10,
        cap: (m.caps[id] ?? 1000) / 10,
        lock: LOCKS[m.locks[id] ?? 0] ?? 'up'
      }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value),
    gold: {
      carried: coins((p) => p.place !== 'bank'),
      bankBalance: account?.gold ?? 0,
      bankCoins: coins((p) => p.place === 'bank'),
      checks: checks.reduce((n, p) => n + (p.item.worth ?? 0), 0)
    },
    items: held.map((p) => ({
      serial: p.item.serial,
      item: itemLabel(p.item),
      type: p.item.type,
      graphic: p.item.graphic,
      hue: p.item.hue,
      amount: p.item.amount,
      place: p.place,
      container: p.path.map(itemLabel)
    }))
  };
}

export type CharacterRecord = ReturnType<typeof characterRecord>;

export function characterReport(c: CharacterRecord) {
  const lines = [
    `# ${c.name} (${c.serial})`,
    '',
    `${c.resident ? 'Resident' : 'Player'}, account ${c.account ?? '?'}, ${c.online ? 'online' : 'offline'} at ${c.location.map} ${c.location.x},${c.location.y},${c.location.z}. Created ${c.created}.`,
    '',
    `Str ${c.stats.str}, Dex ${c.stats.dex}, Int ${c.stats.int}, Hits ${c.stats.hits}. Fame ${c.fame}, Karma ${c.karma}, Kills ${c.kills}, Deaths ${c.deaths}.`,
    '',
    `Gold: ${c.gold.carried} carried, ${c.gold.bankBalance} bank balance, ${c.gold.bankCoins} coins in the bank box, ${c.gold.checks} in checks.`,
    '',
    `## Skills (${c.skillTotal.toFixed(1)} of ${c.skillCap.toFixed(1)})`,
    '',
    table(
      ['Skill', 'Value', 'Cap', 'Lock'],
      c.skills.map((s) => [s.skill, tenths(s.value * 10), tenths(s.cap * 10), s.lock])
    ),
    '',
    `Locks over all skills: ${c.locks.down} set down, ${c.locks.locked} locked.`,
    ''
  ];
  const places = [...new Set(c.items.map((i) => i.place))];
  for (const place of places) {
    const items = c.items.filter((i) => i.place === place);
    lines.push(
      `## ${place[0]?.toUpperCase()}${place.slice(1)} (${items.length} items)`,
      '',
      table(
        ['Item', 'Graphic', 'Hue', 'Amount', 'Inside'],
        items.map((i) => [i.item, `0x${i.graphic.toString(16)}`, i.hue, i.amount, i.container.join(' › ') || '—'])
      ),
      ''
    );
  }
  return lines.join('\n');
}
