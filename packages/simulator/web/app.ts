type Read = { key: string; name: string; value: unknown; calls: number; pinned: boolean };
type Option = {
  id: string;
  key: string;
  value: number;
  rate: number;
  seconds: number;
  chance: number;
  steps: string[];
};
type View = {
  now: number;
  steps: string[];
  log: { at: number; what: string; detail?: unknown }[];
  tuning: { defaults: Record<string, number>; set: Record<string, number> };
  reads: Read[];
  options: Option[];
  error?: string;
};
type Child = { key: string; kind: string; size?: number; value?: unknown };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const who = $<HTMLSelectElement>('who');
const show = (value: unknown) => JSON.stringify(value, null, 1);
const element = (tag: string, className = '', text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
// A typed value: JSON where it parses, else the text itself.
const parse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

let view: View;
let chosen: Option | undefined;
const open = new Set(['self', 'where', 'here', 'traits']);

async function post(path: string, body?: unknown) {
  $('error').textContent = '';
  $('busy').textContent = 'weighing…';
  const res = await fetch(
    `/api/residents/${who.value}${path}`,
    body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }
  );
  const json = await res.json();
  $('busy').textContent = '';
  if (json.error) $('error').textContent = json.error;
  return json;
}

async function change(path: string, body: unknown) {
  const next = await post(path, body);
  if (!next.error) render(next);
}

function render(next: View) {
  view = next;
  $('now').textContent = new Date(view.now).toISOString().replace('T', ' ').slice(0, 19);
  $('steps').innerHTML = '';
  for (const step of view.steps) $('steps').append(element('li', '', step));
  chosen = view.options.find((o) => o.id === chosen?.id);
  renderOptions();
  renderReads();
  renderTuning();
  $('log').textContent = view.log
    .map(
      (l) => `${new Date(l.at).toISOString().slice(11, 19)} ${l.what}${l.detail ? ` ${JSON.stringify(l.detail)}` : ''}`
    )
    .reverse()
    .join('\n');
  renderState();
}

// The mind's state, a level at a time; open branches stay open across changes.
async function renderState() {
  const root = $('state');
  const fresh = element('div');
  await branch(fresh, []);
  root.replaceChildren(...fresh.childNodes);
}

async function branch(into: HTMLElement, path: string[]) {
  const children = (await post('/state', { path })) as Child[];
  for (const child of children) {
    const at = [...path, child.key];
    const id = at.join('.');
    const row = element('div', 'row');
    const node = element('div', 'node');
    if (child.size === undefined) {
      const leaf = element('span', 'leaf', JSON.stringify(child.value));
      leaf.onclick = () =>
        editor(row, JSON.stringify(child.value), (text) => change('/edit', { path: at, value: parse(text) }));
      row.append(element('span', 'key', child.key), leaf);
    } else {
      const key = element('span', 'key', `${open.has(id) ? '▾' : '▸'} ${child.key}`);
      key.onclick = async () => {
        if (open.has(id)) {
          open.delete(id);
          node.replaceChildren();
        } else {
          open.add(id);
          await branch(node, at);
        }
        key.textContent = `${open.has(id) ? '▾' : '▸'} ${child.key}`;
      };
      row.append(key, element('span', 'meta', `${child.kind} ${child.size}`));
      if (open.has(id)) await branch(node, at);
    }
    into.append(row, node);
  }
}

// A box to type a new value in, below what it changes.
function editor(after: HTMLElement, value: string, done: (text: string) => void, extra?: HTMLElement) {
  document.querySelector('.editor')?.remove();
  const box = element('div', 'editor');
  const input = document.createElement('textarea');
  input.rows = Math.min(12, value.split('\n').length + 1);
  input.value = value;
  const apply = element('button', '', 'Apply');
  apply.onclick = () => done(input.value);
  const cancel = element('button', '', 'Cancel');
  cancel.onclick = () => box.remove();
  box.append(input, apply, cancel);
  if (extra) box.append(extra);
  after.after(box);
  input.focus();
}

function renderReads() {
  const filter = $<HTMLInputElement>('filter').value.toLowerCase();
  const pinnedOnly = $<HTMLInputElement>('pinnedOnly').checked;
  const about = chosen && [chosen.id, chosen.key, ...chosen.key.split(/[: ]/)].map((s) => s.toLowerCase());
  const groups = new Map<string, Read[]>();
  for (const read of view.reads) {
    const text = read.key.toLowerCase();
    if (filter && !text.includes(filter)) continue;
    if (pinnedOnly && !read.pinned) continue;
    groups.set(read.name, [...(groups.get(read.name) ?? []), read]);
  }
  const root = $('reads');
  const wasOpen = new Set([...root.querySelectorAll('details[open]')].map((d) => d.getAttribute('data-name')));
  root.replaceChildren();
  for (const [name, reads] of [...groups].sort((a, b) => a[1].length - b[1].length)) {
    const group = document.createElement('details');
    group.className = 'group';
    group.dataset.name = name;
    const relevant = about
      ? reads.filter((r) => about.some((a) => a.length > 2 && r.key.toLowerCase().includes(a)))
      : [];
    group.open = wasOpen.has(name) || reads.length === 1 || relevant.length > 0 || !!filter;
    const calls = reads.reduce((n, r) => n + r.calls, 0);
    group.append(
      element(
        'summary',
        '',
        `${name} — ${reads.length} asked, ${calls} times${relevant.length ? ` (${relevant.length} about the chosen option)` : ''}`
      )
    );
    for (const read of (relevant.length ? relevant : reads).slice(0, 300)) {
      const row = element('div', `read${read.pinned ? ' pinned' : ''}`);
      row.append(
        element('div', 'key', `${read.pinned ? '📌 ' : ''}${read.key}  ×${read.calls}`),
        element('pre', 'value', show(read.value))
      );
      row.onclick = () => {
        const unpin = element('button', '', 'Unpin');
        unpin.onclick = () => change('/pin', { key: read.key });
        editor(
          row,
          show(read.value),
          (text) => change('/pin', { key: read.key, value: parse(text) }),
          read.pinned ? unpin : undefined
        );
      };
      group.append(row);
    }
    root.append(group);
  }
}

function renderOptions() {
  const body = $('options');
  body.replaceChildren();
  view.options.forEach((o, i) => {
    const tr = element('tr', o.id === chosen?.id ? 'chosen' : '');
    for (const cell of [
      i + 1,
      o.key,
      o.value.toFixed(2),
      o.rate.toFixed(3),
      Math.round(o.seconds),
      o.chance?.toFixed(2)
    ])
      tr.append(element('td', '', String(cell)));
    tr.onclick = () => {
      chosen = o;
      renderOptions();
      renderReads();
    };
    body.append(tr);
  });
  renderDetail();
}

// The chosen option, everything planning made of it, and what came of doing it.
function renderDetail() {
  const root = $('detail');
  root.replaceChildren();
  if (!chosen) return;
  const o = chosen;
  root.append(element('h2', '', `Doing ${o.key}`));
  const form = element('div', 'editor');
  form.innerHTML = `
    <label><input type="checkbox" id="ok" checked /> succeeded</label>
    <label>took <input id="took" size="5" value="${Math.round(o.seconds)}" />s</label><br />
    <label>then health <input id="hp" size="5" /></label>
    <label>at <input id="x" size="5" />,<input id="y" size="5" /></label><br />
    <label>skill <input id="skill" size="12" placeholder="Macing" /> = <input id="sv" size="5" /></label><br />
    <label>and perceived (events, JSON list)</label>
    <textarea id="events" rows="3" placeholder='[{"kind":"self","data":{"poison":1}}]'></textarea>`;
  const value = (id: string) => (form.querySelector(`#${id}`) as HTMLInputElement).value.trim();
  const go = element('button', '', 'Do it');
  go.onclick = () => {
    const events: unknown[] = value('events') ? JSON.parse(value('events')) : [];
    if (value('hp')) events.push({ kind: 'self', data: { health: { current: Number(value('hp')) } } });
    if (value('x') && value('y'))
      events.push({ kind: 'self', data: {}, where: { x: Number(value('x')), y: Number(value('y')), z: 0, map: 1 } });
    if (value('skill')) events.push({ kind: 'skill', data: { skill: value('skill'), value: Number(value('sv')) } });
    const ok = (form.querySelector('#ok') as HTMLInputElement).checked;
    change('/act', { id: o.id, succeeded: ok, seconds: Number(value('took')), events });
  };
  form.append(go);
  root.append(form, element('pre', '', show(o)));
}

function renderTuning() {
  const root = $('tuning');
  root.replaceChildren();
  for (const [name, initial] of Object.entries(view.tuning.defaults)) {
    const label = element('label', '', `${name} `);
    const input = document.createElement('input');
    input.size = 5;
    input.value = String(view.tuning.set[name] ?? initial);
    input.onchange = () => change('/tune', { values: { [name]: Number(input.value) } });
    label.append(input);
    root.append(label);
  }
}

$('filter').oninput = () => renderReads();
$('pinnedOnly').onchange = () => renderReads();
$('undo').onclick = () => change('/undo', {});
$('reset').onclick = () => change('/reset', {});
$('wait').onclick = () => change('/wait', { seconds: Number($<HTMLInputElement>('seconds').value) });
$('tell').onclick = () => change('/tell', parse($<HTMLTextAreaElement>('event').value));
who.onchange = async () => {
  chosen = undefined;
  render(await post(''));
};
for (const { resident } of (await (await fetch('/api/residents')).json()) as { resident: string }[])
  who.append(new Option(resident, resident));
render(await post(''));
