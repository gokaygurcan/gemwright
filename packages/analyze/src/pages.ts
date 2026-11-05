import { FACET_SIZES } from '@gemwright/common/assets/facet';
import { LAYERS } from '@gemwright/common/game/layers';
import { MAPS } from '@gemwright/common/game/maps';
import { skillLabel } from '@gemwright/common/game/skills';
import type { Item, Mobile } from '@gemwright/common/saves/servuo';

import type { Analysis } from './analysis';
import { artUrl, characterScene, SCENE_STYLE } from './character-view';
import type { ClientFiles } from './client';
import { type Block, type Cell, type Doc, link, num } from './doc';
import { holderKind, itemLabel, type Placement } from './owners';
import type { Hit } from './search';

// The save's own pages: an overview, search results, and one page per mobile and per item that
// links to its holder, containers and contents.
const hex = (serial: number) => `0x${serial.toString(16)}`;
const typeName = (type: string) => type.replace(/^Server\.(Items|Mobiles|Multis)\./, '');
const layerNames = new Map<number, string>(Object.entries(LAYERS).map(([name, id]) => [id, name]));
const mobileLink = (m: Mobile) => link(m.name ?? typeName(m.type), `/mobile/${m.serial}`);
// An item's picture: its own art, or a ridden ethereal's statuette.
const pictureUrl = (i: Item) => artUrl((i.statue ?? i).graphic, (i.statue ?? i).hue);
// An item's link, with its art when the client files can draw it.
const itemLink = (i: Item, client?: ClientFiles, text = itemLabel(i)): Cell => ({
  text,
  href: `/item/${i.serial}`,
  icon: client ? pictureUrl(i) : undefined
});
const serialCell = (serial: number): Cell => ({ text: String(serial), muted: hex(serial), sort: serial });
// A place in the world, linking to it on the world map.
const where = (map: number, p: { x: number; y: number; z?: number }, note = ''): Cell => {
  const text = `${MAPS[map] ?? map} ${p.x},${p.y}${p.z !== undefined ? `,${p.z}` : ''}${note}`;
  return FACET_SIZES[map] ? link(text, `/map?m=${map}&px=${p.x}&py=${p.y}`) : text;
};
const path = (items: Item[]) => items.map((i) => itemLabel(i)).join(' › ');

export function searchDoc(a: Analysis, query: string, hits: Hit[], client?: ClientFiles): Doc {
  return {
    title: `Results for “${query}”`,
    blocks: [
      {
        kind: 'table',
        head: ['Name', 'Kind', 'Serial', 'Detail'],
        empty: 'Nothing matches.',
        rows: hits.map((h) => {
          const item = h.kind === 'item' ? a.world.items.get(h.serial) : undefined;
          return [
            item ? itemLink(item, client, h.label) : link(h.label, `/mobile/${h.serial}`),
            h.kind,
            serialCell(h.serial),
            h.detail
          ];
        })
      }
    ]
  };
}

// The items a mobile holds, one table per place (backpack, bank, worn...).
function heldBlocks(held: Placement[], client?: ClientFiles): Block[] {
  return [...new Set(held.map((p) => p.place))].flatMap((place): Block[] => {
    const rows = held.filter((p) => p.place === place);
    return [
      { kind: 'heading', text: `${place} (${rows.length})` },
      {
        kind: 'table',
        head: ['Item', 'Graphic', 'Hue', 'Amount', 'Inside'],
        numeric: [2, 3],
        interactive: rows.length > 15,
        rows: rows.map((p) => [
          itemLink(p.item, client),
          hex(p.item.graphic),
          p.item.hue,
          p.item.amount,
          path(p.path) || '—'
        ])
      }
    ];
  });
}

// The creatures that obey a mobile (BaseCreature ControlMaster): its ridden mount and the pets
// that follow it, each holding follower slots.
function followerBlocks(a: Analysis, m: Mobile): Block[] {
  const ridden = new Set(
    (a.held.get(m.serial) ?? []).flatMap((p) => (p.item.mount === undefined ? [] : [p.item.mount]))
  );
  const followers = [...a.world.mobiles.values()].filter((x) => x.master === m.serial);
  if (!followers.length) return [];
  return [
    { kind: 'heading', text: `Followers (${followers.length}; ${m.followersMax} slots)` },
    {
      kind: 'table',
      head: ['Name', 'Type', 'Body', 'Where'],
      rows: followers.map((x) => [
        mobileLink(x),
        typeName(x.type),
        hex(x.body),
        ridden.has(x.serial) ? 'ridden' : where(x.map, x.location)
      ])
    }
  ];
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
          ['Where', where(m.map, m.location, m.player ? (m.online ? ' (online)' : ' (logout location)') : '')],
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
      ...followerBlocks(a, m),
      { kind: 'heading', text: 'Items' },
      ...heldBlocks(a.held.get(m.serial) ?? [], client)
    ]
  };
}

export function itemDoc(a: Analysis, i: Item, client?: ClientFiles): Doc {
  const p = a.placements.get(i.serial);
  const inside = a.contents.get(i.serial) ?? [];
  const outer = p?.path[0] ?? i;
  return {
    title: itemLabel(i),
    blocks: [
      ...(client ? [{ kind: 'art', src: pictureUrl(i), alt: itemLabel(i) } as Block] : []),
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
        rows: inside.map((x) => [itemLink(x, client), hex(x.graphic), x.hue, x.amount])
      }
    ]
  };
}
