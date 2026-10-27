import { useMemo, useState } from 'preact/hooks';

import type { Block, Cell } from '../src/doc';

// Renders a page's blocks (src/doc.ts): notes, headings, fact lists, tables that sort and filter,
// preformatted text and the server-drawn character scene.
const text = (cell: Cell) => (cell === null ? '' : typeof cell === 'object' ? cell.text : String(cell));
const sortValue = (cell: Cell) =>
  cell === null ? '' : typeof cell === 'object' ? (cell.sort ?? cell.text) : typeof cell === 'number' ? cell : cell;

export function CellView({ cell }: { cell: Cell }) {
  if (cell === null || cell === '') return null;
  if (typeof cell !== 'object') return <>{typeof cell === 'number' ? cell.toLocaleString('en-GB') : cell}</>;
  const main = cell.href ? <a href={cell.href}>{cell.text}</a> : cell.text;
  return (
    <span class={cell.tone ? `tone-${cell.tone}` : undefined}>
      {main}
      {cell.muted && <span class="muted"> {cell.muted}</span>}
    </span>
  );
}

function Table({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  const numeric = new Set(block.numeric ?? []);
  const [sort, setSort] = useState<{ col: number; asc: boolean } | undefined>();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = q
      ? block.rows.filter((r) =>
          text(r[0] ?? null)
            .toLowerCase()
            .includes(q)
        )
      : [...block.rows];
    if (sort) {
      const value = (r: Cell[]) => sortValue(r[sort.col] ?? null);
      shown.sort((x, y) => {
        const a = value(x);
        const b = value(y);
        const order = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
        return sort.asc ? order : -order;
      });
    }
    return shown;
  }, [block.rows, sort, query]);
  if (!block.rows.length) return <p class="muted">{block.empty ?? 'None.'}</p>;
  const toggle = (col: number) =>
    setSort((s) => (s?.col === col ? { col, asc: !s.asc } : { col, asc: !numeric.has(col) }));
  return (
    <div class="table-block">
      {block.interactive && (
        <div class="table-tools">
          <input
            aria-label={`Filter by ${block.head[0]?.toLowerCase() ?? 'name'}`}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder={`Filter by ${block.head[0]?.toLowerCase() ?? 'name'}`}
            type="search"
            value={query}
          />
          <span class="muted">
            {rows.length === block.rows.length ? `${rows.length} rows` : `${rows.length} of ${block.rows.length}`}
          </span>
        </div>
      )}
      <div class="scroll">
        <table>
          <thead>
            <tr>
              {block.head.map((h, i) => (
                <th
                  aria-sort={sort?.col === i ? (sort.asc ? 'ascending' : 'descending') : undefined}
                  class={numeric.has(i) ? 'n' : undefined}
                  key={h + i}
                >
                  {block.interactive ? (
                    <button class="sort" onClick={() => toggle(i)} type="button">
                      {h}
                    </button>
                  ) : (
                    h
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td class={numeric.has(i) ? 'n' : undefined} key={i}>
                    <CellView cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'note':
      return <p class="muted">{block.text}</p>;
    case 'heading':
      return <h2>{block.text}</h2>;
    case 'fields':
      return (
        <dl class="fields">
          {block.rows
            .filter(([, v]) => v !== null && v !== '')
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  <CellView cell={v} />
                </dd>
              </div>
            ))}
        </dl>
      );
    case 'table':
      return <Table block={block} />;
    case 'pre':
      return <pre class="scroll">{block.text}</pre>;
    case 'html':
      return (
        <>
          {block.style && <style>{block.style}</style>}
          {/* Markup the analyzer server drew from the client's art, its text escaped there. */}
          <div dangerouslySetInnerHTML={{ __html: block.html }} />
        </>
      );
  }
}
