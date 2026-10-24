import { skillLabel, skillNames } from '@gemwright/common/skills';

import type { Analysis } from './analysis';
import type { CharacterRecord } from './character';
import { bump, list, median, table, tenths } from './markdown';
import { holderKind, itemLabel, type Place } from './owners';

// The world save as a Markdown report: where every item is and who holds it, and for the AI
// residents how far their skills have grown, what they carry and bank, and where they stand.
const shortType = (type: string) => type.replace(/^Server\.(Items|Mobiles|Multis)\./, '');

export function report(a: Analysis) {
  const residents = a.characters.filter((c) => c.resident);
  const mobiles = [...a.world.mobiles.values()];
  const creatures = new Map<string, number>();
  for (const m of mobiles) if (!m.player) bump(creatures, shortType(m.type));
  return [
    '# World save',
    '',
    `Source: ${a.source}`,
    '',
    '## Overview',
    '',
    table(
      ['What', 'Count'],
      [
        ['Mobiles', mobiles.length],
        ['Player characters', a.characters.length],
        ['Resident characters', residents.length],
        ['Residents online at the save', residents.filter((c) => c.online).length],
        ['Items', a.world.items.size],
        ['Records not decoded', a.world.errors.length],
        ['Items read only to their header', [...a.world.items.values()].filter((i) => i.partial).length]
      ]
    ),
    '',
    `Commonest creatures: ${list(creatures, 12)}.`,
    '',
    ...items(a),
    ...skills(a, residents),
    ...wealth(residents),
    ...banks(residents),
    ...whereabouts(residents)
  ].join('\n');
}

// Every item by where it is and whose it is.
function items(a: Analysis) {
  const kinds = ['resident', 'player', 'creature', 'none'] as const;
  const counts = new Map<string, number>();
  const places = new Set<Place>();
  const residentKinds = new Map<Place, Map<string, number>>();
  for (const p of a.placements.values()) {
    const kind = holderKind(p.holder, a.residents);
    places.add(p.place);
    bump(counts, `${p.place}:${kind}`);
    if (kind !== 'resident') continue;
    const byKind = residentKinds.get(p.place) ?? new Map<string, number>();
    residentKinds.set(p.place, byKind);
    bump(byKind, itemLabel(p.item), p.item.stackable ? p.item.amount : 1);
  }
  return [
    '## Items',
    '',
    'Every item, by where it is and who holds it. Items inside containers count where their outermost container is; stackables count by amount in the lists below.',
    '',
    table(
      ['Place', 'Residents', 'Other players', 'Creatures and vendors', 'Nobody'],
      [...places].map((place) => [place, ...kinds.map((k) => counts.get(`${place}:${k}`) ?? 0)])
    ),
    '',
    '### What residents hold, by place',
    '',
    ...[...residentKinds].flatMap(([place, byKind]) => [`- **${place}:** ${list(byKind, 12)}.`]),
    ''
  ];
}

function skills(a: Analysis, residents: CharacterRecord[]) {
  const mobiles = residents.flatMap((c) => a.world.mobiles.get(c.serial) ?? []);
  const best = mobiles.map((m) => Math.max(0, ...m.skills));
  const totals = mobiles.map((m) => m.skills.reduce((n, v) => n + v, 0));
  const primary = new Map<string, number>();
  for (const m of mobiles) {
    const high = Math.max(...m.skills);
    if (high > 0) bump(primary, skillLabel(m.skills.indexOf(high)));
  }
  const perSkill = skillNames
    .map((_, i) => {
      const values = mobiles.map((m) => m.skills[i] ?? 0).filter((v) => v > 0);
      return {
        name: skillLabel(i),
        trained: values.length,
        median: median(values),
        high: Math.max(0, ...values),
        grand: values.filter((v) => v >= 1000).length,
        locked: mobiles.filter((m) => (m.skills[i] ?? 0) > 0 && m.locks[i] === 2).length
      };
    })
    .filter((s) => s.trained)
    .sort((x, y) => y.trained - x.trained);
  return [
    '## Skills',
    '',
    table(
      ['Best skill at least', 'Residents'],
      [1000, 900, 800, 700, 500, 300].map((t) => [tenths(t), best.filter((b) => b >= t).length])
    ),
    '',
    `Median skill total ${tenths(median(totals))}, highest ${tenths(Math.max(0, ...totals))}. Median best skill ${tenths(median(best))}.`,
    '',
    `Best skill by kind: ${list(primary, 20)}.`,
    '',
    table(
      ['Skill', 'Trained', 'Median', 'Highest', 'At 100', 'Locked'],
      perSkill.map((s) => [s.name, s.trained, tenths(s.median), tenths(s.high), s.grand, s.locked])
    ),
    '',
    '### Most skilled',
    '',
    table(
      ['Resident', 'Total', 'Top skills', 'Str/Dex/Int'],
      [...residents]
        .sort((x, y) => y.skillTotal - x.skillTotal)
        .slice(0, 15)
        .map((c) => [
          c.name,
          c.skillTotal.toFixed(1),
          c.skills
            .slice(0, 3)
            .map((s) => `${s.skill} ${s.value.toFixed(1)}`)
            .join(', '),
          `${c.stats.str}/${c.stats.dex}/${c.stats.int}`
        ])
    ),
    ''
  ];
}

const banked = (c: CharacterRecord) => c.gold.bankBalance + c.gold.bankCoins + c.gold.checks;
const worth = (c: CharacterRecord) => c.gold.carried + banked(c);

function wealth(residents: CharacterRecord[]) {
  const columns = [(c: CharacterRecord) => c.gold.carried, banked, worth];
  return [
    '## Wealth',
    '',
    'Banked is the account balance (EJ keeps deposited gold there), coins in the bank box and bank checks.',
    '',
    table(
      ['', 'Carried', 'Banked', 'Both'],
      [
        ['Total', ...columns.map((f) => residents.reduce((n, c) => n + f(c), 0))],
        ['Median', ...columns.map((f) => median(residents.map(f)))],
        ['Highest', ...columns.map((f) => Math.max(0, ...residents.map(f)))],
        ['With 10,000 or more', '', '', residents.filter((c) => worth(c) >= 10000).length]
      ]
    ),
    '',
    table(
      ['Richest', 'Gold', 'Best skill'],
      [...residents]
        .sort((x, y) => worth(y) - worth(x))
        .slice(0, 10)
        .map((c) => [c.name, worth(c), c.skills[0] ? `${c.skills[0].skill} ${c.skills[0].value.toFixed(1)}` : '—'])
    ),
    ''
  ];
}

// What fills bank boxes: how many items each holds against the 125 limit, the commonest kinds,
// and kinds kept in several piles of the same graphic and colour in one box (stackables that did
// not merge; ore heaps of different sizes are different graphics and never merge).
function banks(residents: CharacterRecord[]) {
  const kinds = new Map<string, number>();
  const split = new Map<string, number>();
  const sizes = residents.map((c) => {
    // The box itself is the bank item with no container around it.
    const inBox = c.items.filter((i) => i.place === 'bank' && i.container.length > 0);
    for (const i of inBox) bump(kinds, i.item);
    const piles = new Map<string, number>();
    for (const i of inBox.filter((i) => i.container.length === 1 && i.amount > 1))
      bump(piles, `${i.type}:${i.graphic}:${i.hue}`);
    for (const [key, n] of piles) if (n > 1) bump(split, shortType(key.split(':')[0] ?? ''));
    return inBox.length;
  });
  return [
    '## Bank boxes',
    '',
    table(
      ['Items in box', 'Residents'],
      [
        ['none', sizes.filter((s) => s === 0).length],
        ['1–49', sizes.filter((s) => s > 0 && s < 50).length],
        ['50–109', sizes.filter((s) => s >= 50 && s < 110).length],
        ['110–125 (nearly full)', sizes.filter((s) => s >= 110).length]
      ]
    ),
    '',
    `Commonest kinds across all boxes: ${list(kinds, 15)}.`,
    '',
    split.size
      ? `Stackables in more than one pile of the same graphic and colour, by boxes affected: ${list(split, 10)}.`
      : 'Every stackable kind is in one pile per graphic and colour.',
    ''
  ];
}

// Where residents stand, by map and 128-tile area.
function whereabouts(residents: CharacterRecord[]) {
  const areas = new Map<string, number>();
  for (const c of residents)
    bump(areas, `${c.location.map} ${Math.floor(c.location.x / 128) * 128},${Math.floor(c.location.y / 128) * 128}`);
  return [
    '## Where residents are',
    '',
    table(
      ['Area (map, top-left of 128×128)', 'Residents'],
      [...areas]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 15)
        .map(([area, n]) => [area, n])
    ),
    ''
  ];
}
