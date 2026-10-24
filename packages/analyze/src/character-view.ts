import { gold } from '@gemwright/common/items';
import { LAYERS } from '@gemwright/common/layers';
import { MAPS } from '@gemwright/common/maps';

import type { Analysis } from './analysis';
import type { ClientFiles } from './client';
import { escapeHtml } from './html';
import { itemLabel } from './owners';
import type { Item, Mobile } from './world';

// A character drawn the way the game client shows it, from the client's own art: the world
// around them from above, and around it the radar, status bar, paperdoll, backpack, bank box and
// skills, laid out as ClassicUO lays out those gumps.
const gumpUrl = (id: number, hue = 0, partial = false) =>
  `/gump/${id}${hue ? `?hue=${hue & 0x3fff}${partial ? '&partial=1' : ''}` : ''}`;
const artUrl = (graphic: number, hue = 0) => `/art/${graphic}${hue ? `?hue=${hue & 0x3fff}` : ''}`;
const at = (x: number, y: number) => `left:${x}px;top:${y}px`;

// Paperdoll layers, bottom to top (ClassicUO PaperDollInteractable).
const DOLL_ORDER = [
  LAYERS.cloak,
  LAYERS.shirt,
  LAYERS.pants,
  LAYERS.shoes,
  LAYERS.innerLegs,
  LAYERS.arms,
  LAYERS.innerTorso,
  LAYERS.middleTorso,
  LAYERS.ring,
  LAYERS.bracelet,
  LAYERS.face,
  LAYERS.gloves,
  LAYERS.outerLegs,
  LAYERS.outerTorso,
  LAYERS.waist,
  LAYERS.neck,
  LAYERS.hair,
  LAYERS.facialHair,
  LAYERS.earrings,
  LAYERS.helm,
  LAYERS.oneHanded,
  LAYERS.twoHanded,
  LAYERS.talisman
];
const LOCK_GUMPS = [
  0x984, // up
  0x986, // down
  0x82c // locked
];
const FEMALE_BODIES = new Set([
  0x191, // human female
  0x193, // human female ghost
  0x25e, // elf female
  0x260 // elf female ghost
]);

interface View {
  a: Analysis;
  client: ClientFiles;
  m: Mobile;
  worn: Item[];
}

// The gump a worn item shows on the paperdoll: its tile's animation plus the body's offset, or
// the other body's when only that exists.
function dollGump(client: ClientFiles, graphic: number, female: boolean) {
  const animation = client.tiles.item(graphic).animation;
  const own = animation + (female ? 60000 : 50000);
  if (client.gumpSize(own)) return own;
  const other = animation + (female ? 50000 : 60000);
  return client.gumpSize(other) ? other : undefined;
}

function paperdoll({ client, m, worn }: View) {
  const female = m.female || FEMALE_BODIES.has(m.body);
  const pieces: string[] = [`<img class="layer" src="${gumpUrl(female ? 0x0d : 0x0c, m.hue, true)}" alt="">`];
  const looks: { graphic: number; hue: number; layer: number; item?: Item }[] = [
    ...worn.map((item) => ({ graphic: item.graphic, hue: item.hue, layer: item.layer, item })),
    ...(m.hair ? [{ ...m.hair, layer: LAYERS.hair }] : []),
    ...(m.beard ? [{ ...m.beard, layer: LAYERS.facialHair }] : [])
  ];
  for (const layer of DOLL_ORDER)
    for (const look of looks.filter((l) => l.layer === layer)) {
      const id = dollGump(client, look.graphic, female);
      if (id === undefined) continue;
      const partial = client.tiles.item(look.graphic).partialHue;
      const image = `<img class="layer" src="${gumpUrl(id, look.hue, partial)}" alt="">`;
      pieces.push(
        look.item
          ? `<a class="layer" href="/item/${look.item.serial}" title="${escapeHtml(itemLabel(look.item))}">${image}</a>`
          : image
      );
    }
  const title = [m.name, m.title].filter(Boolean).join(' ');
  return `<section class="gump doll" style="width:262px;height:324px;background-image:url(${gumpUrl(0x7d0)})" aria-label="Paperdoll">
<div class="figure" style="${at(8, 19)}">${pieces.join('')}</div><p class="doll-title">${escapeHtml(title)}</p></section>`;
}

// A container's gump with its items where they lie in it (each item's saved position).
function container(view: View, box: Item | undefined, gumpId: number, label: string) {
  if (!box) return '';
  const size = view.client.gumpSize(gumpId) ?? { width: 200, height: 200 };
  const items = (view.a.contents.get(box.serial) ?? []).map((item) => {
    const image = `<img src="${artUrl(item.graphic, item.hue)}" alt="">`;
    const second =
      item.stackable && item.amount > 1 ? `<img class="stack" src="${artUrl(item.graphic, item.hue)}" alt="">` : '';
    const name = `${itemLabel(item)}${item.amount > 1 ? ` (${item.amount})` : ''}`;
    return `<a class="thing" style="${at(item.location.x, item.location.y)}" href="/item/${item.serial}" title="${escapeHtml(name)}">${image}${second}</a>`;
  });
  return `<section class="gump" style="width:${size.width}px;height:${size.height}px;background-image:url(${gumpUrl(gumpId)})" aria-label="${escapeHtml(label)}">${items.join('')}</section>`;
}

// ServUO's container gumps by item graphic (Data/containers.cfg); others use the backpack's.
const CONTAINER_GUMPS = new Map([
  [0x0e75, 0x3c], // backpack
  [0x0e7c, 0x4a], // bank box (metal chest)
  [0x09ab, 0x4a], // metal chest
  [0x0e76, 0x3d], // bag
  [0x0e79, 0x3c], // pouch
  [0x0e77, 0x3e], // barrel
  [0x0e7a, 0x3f], // picnic basket
  [0x0e7d, 0x43], // wooden box
  [0x09aa, 0x43], // wooden box
  [0x0e40, 0x42], // metal golden chest
  [0x0e41, 0x42], // metal golden chest
  [0x0e42, 0x49], // wooden chest
  [0x0e43, 0x49] // wooden chest
]);
const containerGump = (item: Item | undefined) => (item ? (CONTAINER_GUMPS.get(item.graphic) ?? 0x3c) : 0x3c);

function radar(view: View) {
  const { m } = view;
  return `<section class="gump radar" style="width:200px;height:200px;background-image:url(${gumpUrl(5010)})" aria-label="Radar">
<div class="radar-map"><img src="/radar/${m.map}/${m.location.x}/${m.location.y}?size=128" alt=""></div><span class="you"></span></section>`;
}

function status(view: View, gold: number, weight: number) {
  const { m } = view;
  const text = (value: unknown, x: number, y: number, width = 0) =>
    `<span class="stat" style="${at(x, y)}${width ? `;width:${width}px;text-align:center` : ''}">${escapeHtml(value)}</span>`;
  const pair = (current: number, max: number, x: number, y: number) =>
    `${text(current, x, y, 40)}<span class="rule" style="${at(x + 4, y + 13)}"></span>${text(max, x, y + 13, 40)}`;
  const locks = [76, 102, 132]
    .map(
      (y, i) =>
        `<img class="lock" style="${at(28, y)}" src="${gumpUrl(LOCK_GUMPS[m.statLocks[i] ?? 0] ?? 0x984)}" alt="">`
    )
    .join('');
  return `<section class="gump status" style="width:577px;height:216px;background-image:url(${gumpUrl(0x2a6c)})" aria-label="Status">
${text(m.name ?? '', 90, 50, 320)}${locks}
${text(m.str, 80, 77)}${text(m.dex, 80, 105)}${text(m.int, 80, 133)}
${pair(m.hits, Math.max(m.hits, 50 + Math.floor(m.str / 2)), 145, 70)}${pair(m.stamina, Math.max(m.stamina, m.dex), 145, 98)}${pair(m.mana, Math.max(m.mana, m.int), 145, 126)}
${text(m.statCap, 240, 77)}${pair(weight, 40 + Math.floor(3.5 * m.str), 230, 126)}
${text(`–/${m.followersMax}`, 320, 133)}${text(gold, 480, 161)}</section>`;
}

function skills({ client, m }: View) {
  const { names, groups } = client.skills;
  const total = m.skills.reduce((n, v) => n + v, 0);
  const rows = groups
    .map((group) => {
      const items = [...group.skills]
        .sort((x, y) => (names[x] ?? '').localeCompare(names[y] ?? ''))
        .map(
          (id) =>
            `<li><span>${escapeHtml(names[id])}</span><span class="value" title="cap ${((m.caps[id] ?? 1000) / 10).toFixed(1)}">${((m.skills[id] ?? 0) / 10).toFixed(1)}</span><img src="${gumpUrl(LOCK_GUMPS[m.locks[id] ?? 0] ?? 0x984)}" alt="${['up', 'down', 'locked'][m.locks[id] ?? 0]}"></li>`
        )
        .join('');
      const trained = group.skills.some((id) => (m.skills[id] ?? 0) > 0);
      return `<details${trained ? ' open' : ''}><summary>${escapeHtml(group.name)}</summary><ul>${items}</ul></details>`;
    })
    .join('');
  return `<section class="scroll-gump" aria-label="Skills"><img class="scroll-top" src="${gumpUrl(0x1f40)}" alt="">
<div class="scroll-body" style="background-image:url(${gumpUrl(0x1f41)})"><img class="scroll-title" src="${gumpUrl(0x834)}" alt="Skills">${rows}
<p class="total">${(total / 10).toFixed(1)}</p></div><img class="scroll-bottom" src="${gumpUrl(0x1f43)}" alt=""></section>`;
}

export function characterScene(a: Analysis, client: ClientFiles, m: Mobile) {
  const held = a.contents.get(m.serial) ?? [];
  const worn = held.filter((i) => ![LAYERS.backpack, LAYERS.bank, LAYERS.mount].includes(i.layer as never));
  const view: View = { a, client, m, worn };
  const pack = held.find((i) => i.layer === LAYERS.backpack);
  const bank = held.find((i) => i.layer === LAYERS.bank);
  const carried = (a.held.get(m.serial) ?? []).filter((p) => p.place !== 'bank');
  const coins = carried.filter((p) => p.item.graphic === gold).reduce((n, p) => n + p.item.amount, 0);
  // Tile weight per unit; coins weigh 1 stone per 50 (ServUO Gold).
  const weight = Math.round(
    carried
      .filter((p) => p.place === 'worn' || p.place === 'backpack')
      .reduce(
        (n, p) =>
          n +
          (p.item.graphic === gold
            ? p.item.amount / 50
            : client.tiles.item(p.item.graphic).weight * (p.item.stackable ? p.item.amount : 1)),
        0
      )
  );
  const mountItem = held.find((i) => i.layer === LAYERS.mount);
  const mount = mountItem?.mount !== undefined ? a.world.mobiles.get(mountItem.mount) : undefined;
  const where = `${MAPS[m.map] ?? m.map} ${m.location.x},${m.location.y}`;
  return `<div class="scene">
<div class="world" aria-hidden="true"><img src="/radar/${m.map}/${m.location.x}/${m.location.y}?size=600" alt=""></div>
<div class="here"><span class="dot"></span><span class="here-label">${escapeHtml(m.name)}${mount ? ` on ${escapeHtml(mount.name ?? 'a mount')}` : ''}<br><small>${escapeHtml(where)}</small></span></div>
<div class="slot slot-radar">${radar(view)}</div>
<div class="slot slot-doll">${paperdoll(view)}</div>
<div class="slot slot-skills">${skills(view)}</div>
<div class="slot slot-bank">${container(view, bank, containerGump(bank), 'Bank box')}</div>
<div class="slot slot-status">${status(view, coins, weight)}</div>
<div class="slot slot-pack">${container(view, pack, containerGump(pack), 'Backpack')}</div>
</div>`;
}

export const SCENE_STYLE = `
.scene{position:relative;height:1000px;width:100vw;margin:0 0 24px calc(50% - 50vw);overflow:hidden;background:#0c0c0c;border-block:1px solid var(--line)}
.world{position:absolute;left:50%;top:50%;width:600px;height:600px;transform:translate(-50%,-50%) rotate(45deg) scale(3.4);image-rendering:pixelated}
.world img{width:100%;height:100%;display:block;filter:brightness(.8)}
.here{position:absolute;left:50%;top:50%;transform:translate(-6px,-6px);display:flex;gap:8px;align-items:flex-start;color:#fff;text-shadow:0 1px 2px #000,0 0 4px #000;font-weight:600;pointer-events:none}
.dot{width:12px;height:12px;border-radius:50%;background:#f5d76e;box-shadow:0 0 0 3px rgba(0,0,0,.6),0 0 14px #f5d76e}
.here small{font-weight:400}
.slot{position:absolute}.slot-radar{left:24px;top:24px}.slot-doll{right:24px;top:24px}.slot-skills{right:24px;top:370px}
.slot-bank{left:24px;bottom:24px}.slot-status{left:236px;bottom:24px}.slot-pack{right:393px;bottom:24px}
.gump{position:relative;background-repeat:no-repeat;image-rendering:pixelated;color:#000}
.gump .layer{position:absolute;left:0;top:0}.figure{position:absolute;width:250px;height:240px}
.doll-title{position:absolute;left:30px;top:264px;width:200px;margin:0;font:700 13px/1.25 Georgia,serif;color:#1f1f1f}
.thing{position:absolute;line-height:0}.thing img{display:block}.thing .stack{position:absolute;left:5px;top:5px}
.thing:hover img{filter:drop-shadow(0 0 2px #fff)}
.radar-map{position:absolute;left:32px;top:32px;width:136px;height:136px;border-radius:50%;overflow:hidden}
.radar-map img{width:100%;height:100%;transform:rotate(45deg) scale(1.42);image-rendering:pixelated}
.radar .you{position:absolute;left:98px;top:98px;width:4px;height:4px;background:#fff;box-shadow:0 0 0 1px #000}
.stat{position:absolute;font:700 12px/1 Georgia,serif;color:#1d1d1d;white-space:nowrap}.rule{position:absolute;width:32px;height:1px;background:#1d1d1d}.lock{position:absolute}
.scroll-gump{width:345px;position:relative}.scroll-top,.scroll-bottom{display:block}.scroll-bottom{margin-left:16px}
.scroll-body{margin-left:22px;width:302px;padding:6px 26px 8px;box-sizing:border-box;background-repeat:repeat-y;max-height:440px;overflow:auto;color:#1c2a58;font:600 13px/1.35 Georgia,serif;scrollbar-width:thin}
.scroll-title{display:block;margin:0 auto 6px}.scroll-body summary{cursor:pointer;color:#14224a;font-weight:700}
.scroll-body ul{list-style:none;margin:2px 0 6px;padding:0 0 0 12px}.scroll-body li{display:flex;align-items:center;gap:6px}
.scroll-body li span:first-child{flex:1}.scroll-body .value{font-variant-numeric:tabular-nums}.total{text-align:right;margin:6px 0 0;font-size:16px}
@media (max-width:1400px){
.scene{height:auto;display:flex;flex-wrap:wrap;gap:16px;padding:16px;justify-content:center}
.world,.here{display:none}.slot{position:static;transform:none;max-width:100%;overflow-x:auto}}
`;
