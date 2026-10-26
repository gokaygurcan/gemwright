import type { Analysis } from './analysis';
import { escapeHtml } from './html';
import { layout } from './pages';

// Every player character in one table: filter by typing, sort by clicking a column heading
// (again to reverse). The rows are rendered on the server; a small script filters and sorts them.
const goldOf = (c: Analysis['characters'][number]) =>
  c.gold.carried + c.gold.bankBalance + c.gold.bankCoins + c.gold.checks;

export function playersPage(a: Analysis) {
  const rows = [...a.characters]
    .sort((x, y) => y.skillTotal - x.skillTotal)
    .map((c) => {
      const stats = c.stats.str + c.stats.dex + c.stats.int;
      const gold = goldOf(c);
      return `<tr data-name="${escapeHtml(c.name.toLowerCase())}"><td data-v="${escapeHtml(c.name.toLowerCase())}"><a href="/mobile/${c.serial}">${escapeHtml(c.name)}</a></td><td data-v="${c.resident ? 1 : 0}">${c.resident ? 'resident' : 'player'}</td><td class="n" data-v="${c.skillTotal}">${c.skillTotal.toFixed(1)}</td><td class="n" data-v="${stats}">${stats}</td><td class="n" data-v="${gold}">${gold.toLocaleString('en-GB')}</td></tr>`;
    })
    .join('');
  const heads = ['Name', 'Kind', 'Skill total', 'Stat total', 'Gold']
    .map((h, i) => `<th><button type="button" class="sort" data-col="${i}">${h}</button></th>`)
    .join('');
  return layout(
    'Players',
    `<h1>Players</h1><p class="muted"><span id="shown">${a.characters.length}</span> of ${a.characters.length} characters</p>
<input id="filter" type="search" placeholder="Filter by name" aria-label="Filter by name" autocomplete="off">
<div class="scroll"><table id="players"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div>
<style>#filter{display:block;width:100%;max-width:360px;margin:8px 0 12px}.n{text-align:right}
th button.sort{all:unset;cursor:pointer;font-weight:600}th button.sort[aria-sort=ascending]::after{content:" ▲"}th button.sort[aria-sort=descending]::after{content:" ▼"}</style>
<script>
const body = document.querySelector('#players tbody');
const rows = [...body.rows];
const filter = document.getElementById('filter');
filter.addEventListener('input', () => {
  const q = filter.value.trim().toLowerCase();
  let shown = 0;
  for (const row of rows) { const hit = row.dataset.name.includes(q); row.hidden = !hit; shown += hit; }
  document.getElementById('shown').textContent = shown;
});
document.querySelectorAll('button.sort').forEach((button) => button.addEventListener('click', () => {
  const col = Number(button.dataset.col);
  const asc = button.getAttribute('aria-sort') !== 'ascending' && (col < 2 || button.hasAttribute('aria-sort'));
  document.querySelectorAll('button.sort').forEach((b) => b.removeAttribute('aria-sort'));
  button.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
  const value = (row) => { const v = row.cells[col].dataset.v; return col === 0 ? v : Number(v); };
  rows.sort((x, y) => { const a = value(x), b = value(y); return (a < b ? -1 : a > b ? 1 : 0) * (asc ? 1 : -1); });
  body.append(...rows);
}));
</script>`
  );
}
