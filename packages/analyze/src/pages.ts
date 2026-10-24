import { LAYERS } from '@gemwright/common/layers';
import { MAPS } from '@gemwright/common/maps';
import { skillLabel } from '@gemwright/common/skills';

import type { Analysis } from './analysis';
import { characterScene, SCENE_STYLE } from './character-view';
import type { ClientFiles } from './client';
import { escapeHtml } from './html';
import { holderKind, itemLabel, type Placement } from './owners';
import type { Hit } from './search';
import type { Item, Mobile } from './world';

// The analyzer's pages as HTML strings: a search page, and one page per mobile and per item that
// links to its holder, containers and contents.
const hex = (serial: number) => `0x${serial.toString(16)}`;
const typeName = (type: string) => type.replace(/^Server\.(Items|Mobiles|Multis)\./, '');
const layerNames = new Map<number, string>(Object.entries(LAYERS).map(([name, id]) => [id, name]));
const mobileLink = (m: Mobile) => `<a href="/mobile/${m.serial}">${escapeHtml(m.name ?? typeName(m.type))}</a>`;
const itemLink = (i: Item) => `<a href="/item/${i.serial}">${escapeHtml(itemLabel(i))}</a>`;
const fields = (rows: [string, string | number | undefined][]) =>
  `<dl>${rows
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`)
    .join('')}</dl>`;
const table = (head: string[], rows: string[][]) =>
  rows.length
    ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`
    : '<p class="muted">None.</p>';
const where = (map: number, p: { x: number; y: number; z?: number }) =>
  `${escapeHtml(MAPS[map] ?? map)} ${p.x},${p.y}${p.z !== undefined ? `,${p.z}` : ''}`;

// What the header shows about the data: when it was pulled (live) or the save files' date (local),
// and in live mode a button
// that pulls the shard's latest save (serve.ts).
export const status: { live: boolean; savedAt?: Date; refreshing: boolean; error?: string } = {
  live: false,
  refreshing: false
};

function dataBar() {
  const saved = status.savedAt
    ? `${status.live ? 'Pulled' : 'Save files dated'} ${status.savedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
    : '';
  const refresh = status.live
    ? status.refreshing
      ? '<span class="muted">Pulling the latest save…</span>'
      : '<form method="post" action="/refresh"><button>Refresh</button></form>'
    : '<span class="muted">local</span>';
  const error = status.error ? `<span class="error">${escapeHtml(status.error)}</span>` : '';
  return `<div class="data"><span class="muted">${saved}</span>${refresh}${error}</div>`;
}

export function layout(title: string, body: string, query = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Gemwright save</title><style>${STYLE}${SCENE_STYLE}</style></head><body><header>
<a class="home" href="/">Gemwright save</a><form class="search" action="/search"><input name="q" value="${escapeHtml(query)}" placeholder="Name, type or serial" autofocus aria-label="Search"><button>Search</button></form>${dataBar()}
</header><main>${body}</main></body></html>`;
}

export function homePage(a: Analysis) {
  const residents = a.characters.filter((c) => c.resident);
  return layout(
    'Overview',
    `<h1>World save</h1><p class="muted">${escapeHtml(a.source)}</p>${fields([
      ['Mobiles', a.world.mobiles.size],
      ['Player characters', a.characters.length],
      ['Residents', `${residents.length} (${residents.filter((c) => c.online).length} online at the save)`],
      ['Items', a.world.items.size],
      ['Records not decoded', a.world.errors.length]
    ])}<h2>Most skilled residents</h2>${table(
      ['Character', 'Skill total', 'Best skill', 'Gold'],
      [...residents]
        .sort((x, y) => y.skillTotal - x.skillTotal)
        .slice(0, 25)
        .map((c) => [
          `<a href="/mobile/${c.serial}">${escapeHtml(c.name)}</a>`,
          c.skillTotal.toFixed(1),
          c.skills[0] ? `${escapeHtml(c.skills[0].skill)} ${c.skills[0].value.toFixed(1)}` : '—',
          String(c.gold.carried + c.gold.bankBalance + c.gold.bankCoins + c.gold.checks)
        ])
    )}`
  );
}

export function searchPage(query: string, hits: Hit[]) {
  return layout(
    `Search ${query}`,
    `<h1>Results for “${escapeHtml(query)}”</h1>${table(
      ['Name', 'Kind', 'Serial', 'Detail'],
      hits.map((h) => [
        `<a href="/${h.kind === 'item' ? 'item' : 'mobile'}/${h.serial}">${escapeHtml(h.label)}</a>`,
        h.kind,
        `${h.serial} <span class="muted">${hex(h.serial)}</span>`,
        escapeHtml(h.detail)
      ])
    )}`,
    query
  );
}

// The items a mobile holds, grouped by where they are.
function heldTable(held: Placement[]) {
  const places = [...new Set(held.map((p) => p.place))];
  return places
    .map((place) => {
      const rows = held.filter((p) => p.place === place);
      return `<h3>${escapeHtml(place)} (${rows.length})</h3>${table(
        ['Item', 'Graphic', 'Hue', 'Amount', 'Inside'],
        rows.map((p) => [
          itemLink(p.item),
          hex(p.item.graphic),
          String(p.item.hue),
          String(p.item.amount),
          p.path.map(itemLink).join(' › ') || '—'
        ])
      )}`;
    })
    .join('');
}

export function mobilePage(a: Analysis, m: Mobile, client?: ClientFiles) {
  const c = a.characters.find((x) => x.serial === m.serial);
  const kind = holderKind(m, a.residents);
  const facts = fields([
    ['Serial', `${m.serial} <span class="muted">${hex(m.serial)}</span>`],
    ['Type', escapeHtml(m.type)],
    ['Kind', kind],
    ['Account', escapeHtml(c?.account)],
    ['Title', escapeHtml(m.title)],
    ['Body', hex(m.body)],
    ['Where', `${where(m.map, m.location)}${m.player ? (m.online ? ' (online)' : ' (logout location)') : ''}`],
    ['Str / Dex / Int', `${m.str} / ${m.dex} / ${m.int}`],
    ['Hits', m.hits],
    ['Fame / Karma', `${m.fame} / ${m.karma}`],
    ['Kills / Deaths', `${m.kills} / ${m.deaths}`],
    ['Created', m.created.toISOString()],
    [
      'Gold',
      c
        ? `${c.gold.carried} carried, ${c.gold.bankBalance} bank balance, ${c.gold.bankCoins} coins in the box, ${c.gold.checks} in checks`
        : undefined
    ]
  ]);
  const skills = m.skills
    .map((value, id) => ({ id, value }))
    .filter((s) => s.value > 0)
    .sort((x, y) => y.value - x.value);
  const total = skills.reduce((n, s) => n + s.value, 0);
  return layout(
    m.name ?? typeName(m.type),
    `${client && m.player ? characterScene(a, client, m) : ''}<h1>${escapeHtml(m.name ?? typeName(m.type))}</h1>${facts}<h2>Skills (${(total / 10).toFixed(1)} of ${(m.skillCap / 10).toFixed(1)})</h2>${table(
      ['Skill', 'Value', 'Cap', 'Lock'],
      skills.map((s) => [
        escapeHtml(skillLabel(s.id)),
        (s.value / 10).toFixed(1),
        ((m.caps[s.id] ?? 1000) / 10).toFixed(1),
        ['up', 'down', 'locked'][m.locks[s.id] ?? 0] ?? 'up'
      ])
    )}<h2>Items</h2>${heldTable(a.held.get(m.serial) ?? [])}`
  );
}

export function itemPage(a: Analysis, i: Item) {
  const p = a.placements.get(i.serial);
  const inside = a.contents.get(i.serial) ?? [];
  const outer = p?.path[0] ?? i;
  return layout(
    itemLabel(i),
    `<h1>${escapeHtml(itemLabel(i))}</h1>${fields([
      ['Serial', `${i.serial} <span class="muted">${hex(i.serial)}</span>`],
      ['Type', escapeHtml(i.type)],
      ['Graphic', hex(i.graphic)],
      ['Hue', i.hue],
      ['Amount', i.amount],
      ['Layer', i.layer ? escapeHtml(layerNames.get(i.layer) ?? hex(i.layer)) : undefined],
      ['Flags', [i.movable ? 'movable' : 'fixed', i.stackable ? 'stackable' : ''].filter(Boolean).join(', ')],
      ['Bank check worth', i.worth],
      ['Place', escapeHtml(p?.place)],
      ['Held by', p?.holder ? `${mobileLink(p.holder)} (${holderKind(p.holder, a.residents)})` : undefined],
      ['Inside', p?.path.length ? p.path.map(itemLink).join(' › ') : undefined],
      ['Where', p?.where ? where(p.where.map, p.where) : undefined],
      ['Position in container', i.parent !== undefined && outer !== i ? `${i.location.x},${i.location.y}` : undefined]
    ])}<h2>Contents (${inside.length})</h2>${table(
      ['Item', 'Graphic', 'Hue', 'Amount'],
      inside.map((x) => [itemLink(x), hex(x.graphic), String(x.hue), String(x.amount)])
    )}`
  );
}

const STYLE = `
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b675f;--line:#e2ded5;--link:#2f5d8a;--head:#f1eee7;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#ebe7df;--muted:#a19b90;--line:#34312c;--link:#8db8e3;--head:#22201d;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.home{font-weight:600;color:var(--fg);text-decoration:none}.search{display:flex;gap:8px;flex:1;min-width:240px}
.data{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.data form{margin:0}.error{color:#b3412e}
input{flex:1;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit}
button{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--head);color:inherit;font:inherit;cursor:pointer}
main{max-width:1100px;margin:0 auto;padding:16px}h1{margin:.2em 0 .4em;font-size:1.5rem}h2{margin-top:1.6em;font-size:1.15rem}h3{font-size:1rem;margin-bottom:.4em}
a{color:var(--link)}.muted{color:var(--muted)}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:5px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{background:var(--head);font-weight:600}
`;
