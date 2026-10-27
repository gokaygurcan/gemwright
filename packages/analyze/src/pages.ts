import { LAYERS } from '@gemwright/common/layers';
import { MAPS } from '@gemwright/common/maps';
import { skillLabel } from '@gemwright/common/skills';

import type { Analysis } from './analysis';
import { characterScene, SCENE_STYLE } from './character-view';
import type { ClientFiles } from './client';
import { type Block, type Cell, type Doc, link, num } from './doc';
import { holderKind, itemLabel, type Placement } from './owners';
import type { Hit } from './search';
import type { Item, Mobile } from './world';

// The save's own pages: an overview, search results, and one page per mobile and per item that
// links to its holder, containers and contents.
const hex = (serial: number) => `0x${serial.toString(16)}`;
const typeName = (type: string) => type.replace(/^Server\.(Items|Mobiles|Multis)\./, '');
const layerNames = new Map<number, string>(Object.entries(LAYERS).map(([name, id]) => [id, name]));
const _mobileLink = (m: Mobile) => link(m.name ?? typeName(m.type), `/mobile/${m.serial}`);
const itemLink = (i: Item) => link(itemLabel(i), `/item/${i.serial}`);
const serialCell = (serial: number): Cell => ({ text: String(serial), muted: hex(serial), sort: serial });
const where = (map: number, p: { x: number; y: number; z?: number }) =>
  `${MAPS[map] ?? map} ${p.x},${p.y}${p.z !== undefined ? `,${p.z}` : ''}`;
const path = (items: Item[]) => items.map((i) => itemLabel(i)).join(' › ');

export function overviewDoc(a: Analysis): Doc {
  const residents = a.characters.filter((c) => c.resident);
  return {
    title: 'Overview',
    subtitle: [a.source],
    blocks: [
      {
        kind: 'fields',
        rows: [
          ['Mobiles', num(a.world.mobiles.size)],
          ['Player characters', num(a.characters.length)],
          ['Residents', `${residents.length} (${residents.filter((c) => c.online).length} online at the save)`],
          ['Items', num(a.world.items.size)],
          ['Records not decoded', num(a.world.errors.length)]
        ]
      },
      { kind: 'heading', text: 'Most skilled residents' },
      {
        kind: 'table',
        head: ['Character', 'Skill total', 'Best skill', 'Gold'],
        numeric: [1, 3],
        rows: [...residents]
          .sort((x, y) => y.skillTotal - x.skillTotal)
          .slice(0, 25)
          .map((c) => [
            link(c.name, `/mobile/${c.serial}`),
            num(c.skillTotal, 1),
            c.skills[0] ? `${c.skills[0].skill} ${c.skills[0].value.toFixed(1)}` : '—',
            num(c.gold.carried + c.gold.bankBalance + c.gold.bankCoins + c.gold.checks)
          ])
      }
    ]
  };
}

export function searchDoc(query: string, hits: Hit[]): Doc {
  return {
    title: `Results for “${query}”`,
    blocks: [
      {
        kind: 'table',
        head: ['Name', 'Kind', 'Serial', 'Detail'],
        empty: 'Nothing matches.',
        rows: hits.map((h) => [
          link(h.label, `/${h.kind === 'item' ? 'item' : 'mobile'}/${h.serial}`),
          h.kind,
          serialCell(h.serial),
          h.detail
        ])
      }
    ]
  };
}

// The items a mobile holds, one table per place (backpack, bank, worn...).
function heldBlocks(held: Placement[]): Block[] {
  return [...new Set(held.map((p) => p.place))].flatMap((place): Block[] => {
    const rows = held.filter((p) => p.place === place);
    return [
      { kind: 'heading', text: `${place} (${rows.length})` },
      {
        kind: 'table',
        head: ['Item', 'Graphic', 'Hue', 'Amount', 'Inside'],
        numeric: [2, 3],
        interactive: rows.length > 15,
        rows: rows.map((p) => [itemLink(p.item), hex(p.item.graphic), p.item.hue, p.item.amount, path(p.path) || '—'])
      }
    ];
  });
}

export function mobileDoc(a: Analysis, m: Mobile, client?: ClientFiles): Doc {
  const c = a.characters.find((x) => x.serial === m.serial);
  const skills = m.skills
    .map((value, id) => ({ id, value }))
    .filter((s) => s.value > 0)
    .sort((x, y) => y.value - x.value);
  const total = skills.reduce((n, s) => n + s.value, 0);
  const resident = a.residents.has(m.serial);
  return {
    title: m.name ?? typeName(m.type),
    subtitle: [holderKind(m, a.residents), ...(resident ? [link('replay', `/replay/${m.serial}`)] : [])],
    blocks: [
      ...(client && m.player
        ? [{ kind: 'html', html: characterScene(a, client, m), style: SCENE_STYLE } as Block]
        : []),
      {
        kind: 'fields',
        rows: [
          ['Serial', serialCell(m.serial)],
          ['Type', m.type],
          ['Account', c?.account ?? null],
          ['Title', m.title ?? null],
          ['Body', hex(m.body)],
          ['Where', `${where(m.map, m.location)}${m.player ? (m.online ? ' (online)' : ' (logout location)') : ''}`],
          ['Str / Dex / Int', `${m.str} / ${m.dex} / ${m.int}`],
          ['Hits', m.hits],
          ['Fame / Karma', `${m.fame} / ${m.karma}`],
          ['Kills / Deaths', `${m.kills} / ${m.deaths}`],
          ['Created', m.created.toISOString().slice(0, 16).replace('T', ' ')],
          [
            'Gold',
            c
              ? `${c.gold.carried} carried, ${c.gold.bankBalance} bank balance, ${c.gold.bankCoins} coins in the box, ${c.gold.checks} in checks`
              : null
          ]
        ]
      },
      { kind: 'heading', text: `Skills (${(total / 10).toFixed(1)} of ${(m.skillCap / 10).toFixed(1)})` },
      {
        kind: 'table',
        head: ['Skill', 'Value', 'Cap', 'Lock'],
        numeric: [1, 2],
        rows: skills.map((s) => [
          skillLabel(s.id),
          num(s.value / 10, 1),
          num((m.caps[s.id] ?? 1000) / 10, 1),
          ['up', 'down', 'locked'][m.locks[s.id] ?? 0] ?? 'up'
        ])
      },
      { kind: 'heading', text: 'Items' },
      ...heldBlocks(a.held.get(m.serial) ?? [])
    ]
  };
}

export function itemDoc(a: Analysis, i: Item): Doc {
  const p = a.placements.get(i.serial);
  const inside = a.contents.get(i.serial) ?? [];
  const outer = p?.path[0] ?? i;
  return {
    title: itemLabel(i),
    blocks: [
      {
        kind: 'fields',
        rows: [
          ['Serial', serialCell(i.serial)],
          ['Type', i.type],
          ['Graphic', hex(i.graphic)],
          ['Hue', i.hue],
          ['Amount', i.amount],
          ['Layer', i.layer ? (layerNames.get(i.layer) ?? hex(i.layer)) : null],
          ['Flags', [i.movable ? 'movable' : 'fixed', i.stackable ? 'stackable' : ''].filter(Boolean).join(', ')],
          ['Bank check worth', i.worth ?? null],
          ['Place', p?.place ?? null],
          [
            'Held by',
            p?.holder
              ? link(
                  p.holder.name ?? typeName(p.holder.type),
                  `/mobile/${p.holder.serial}`,
                  holderKind(p.holder, a.residents)
                )
              : null
          ],
          ['Inside', p?.path.length ? path(p.path) : null],
          ['Where', p?.where ? where(p.where.map, p.where) : null],
          ['Position in container', i.parent !== undefined && outer !== i ? `${i.location.x},${i.location.y}` : null]
        ]
      },
      { kind: 'heading', text: `Contents (${inside.length})` },
      {
        kind: 'table',
        head: ['Item', 'Graphic', 'Hue', 'Amount'],
        numeric: [2, 3],
        interactive: inside.length > 15,
        rows: inside.map((x) => [itemLink(x), hex(x.graphic), x.hue, x.amount])
      }
    ]
  };
}
