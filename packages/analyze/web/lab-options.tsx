import { useState } from 'preact/hooks';

import type { Scenario, WeighedOption } from '../src/lab/types';
import { changesIn, type Weighed } from './lab';
import { edit } from './lab-inputs';

// What a decision came to: live, made again as it was, and with the changes; and every option it
// valued, as it was beside as changed, with how each moved. An option can be blocked or let through
// here as the loop breaker would.
const fmt = (n: number | undefined, digits = 2) =>
  n === undefined ? '—' : Number(n.toFixed(digits)).toLocaleString('en-GB');
const planOf = (chose: string) => /\(([^)]*)\)$/.exec(chose)?.[1] ?? chose;

export function Verdict({
  result,
  scenario,
  weighing,
  onReset
}: {
  result: Weighed;
  scenario: Scenario;
  weighing: boolean;
  onReset: () => void;
}) {
  const changes = changesIn(scenario);
  const same = result.live.digest === result.original.digest;
  const now = result.changed;
  const moved = now && now.chose !== result.original.chose;
  return (
    <div class="lab-verdict">
      <div class="lab-card">
        <span class="lab-label">Live</span>
        <strong>{result.live.chose}</strong>
      </div>
      <div class="lab-card">
        <span class="lab-label">Made again</span>
        <strong>{result.original.chose}</strong>
        <span class={same ? 'tone-good' : 'tone-error'}>
          {same ? 'weighed exactly as live' : 'weighed differently from live'}
        </span>
      </div>
      <div class={`lab-card${moved ? ' is-moved' : ''}`}>
        <span class="lab-label">
          With {changes} change{changes === 1 ? '' : 's'}
          {weighing && <span aria-label="Weighing" class="lab-spinner" role="status" />}
        </span>
        <strong>{now ? now.chose : changes ? '…' : 'no changes yet'}</strong>
        {now && (
          <span class={moved ? 'tone-error' : 'muted'}>
            {moved
              ? 'a different choice'
              : now.digest === result.original.digest
                ? 'nothing moved'
                : 'same choice, weighed differently'}
          </span>
        )}
        {changes > 0 && (
          <button class="quiet lab-reset-all" onClick={onReset} type="button">
            Reset all
          </button>
        )}
      </div>
    </div>
  );
}

type Row = {
  id: string;
  key: string;
  learn: string;
  was?: WeighedOption;
  now?: WeighedOption;
  rankWas?: number;
  rankNow?: number;
};

export function Options({
  result,
  scenario,
  setScenario,
  weighing
}: {
  result: Weighed;
  scenario: Scenario;
  setScenario: (s: Scenario) => void;
  weighing: boolean;
}) {
  const [all, setAll] = useState(false);
  const was = result.original.options;
  const now = result.changed?.options;
  const rows = new Map<string, Row>();
  for (const [i, o] of was.entries()) rows.set(o.id, { id: o.id, key: o.key, learn: o.learn, was: o, rankWas: i + 1 });
  now?.forEach((o, i) => {
    const row = rows.get(o.id) ?? { id: o.id, key: o.key, learn: o.learn };
    rows.set(o.id, { ...row, now: o, rankNow: i + 1 });
  });
  const ordered = [...rows.values()].sort(
    (a, b) =>
      (a.rankNow ?? a.rankWas ?? 1e9) - (b.rankNow ?? b.rankWas ?? 1e9) || (a.rankWas ?? 1e9) - (b.rankWas ?? 1e9)
  );
  const chosenWas = planOf(result.original.chose);
  const chosenNow = result.changed && planOf(result.changed.chose);
  const shown = all ? ordered : ordered.slice(0, 25);
  const blocked = (row: Row) => (row.now ?? row.was)?.blocked ?? false;
  return (
    <section aria-label="Options" class={`lab-options${weighing ? ' is-weighing' : ''}`}>
      <h2>
        What it weighed <span class="muted">({was.length} options, best first)</span>
      </h2>
      <p class="muted lab-note">
        Rate is worth per second, travel included: the best one not blocked is chosen, unless even it is at or below the
        change-course line. Untick to block an option as the loop breaker would; tick to let it through.
      </p>
      <div class="scroll">
        <table class="lab-table lab-optable">
          <thead>
            <tr>
              <th class="n">#</th>
              <th>Option</th>
              <th class="n">Worth</th>
              <th class="n">Seconds</th>
              <th class="n">Rate</th>
              <th>Allowed</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const moveBy = row.rankWas && row.rankNow ? row.rankWas - row.rankNow : 0;
              const chose = row.id === (chosenNow ?? chosenWas);
              const wasChosen = row.id === chosenWas;
              const forced = scenario.blocked?.[row.id];
              return (
                <tr class={`${chose ? 'is-chosen' : ''}${wasChosen && !chose ? ' was-chosen' : ''}`} key={row.id}>
                  <td class="n">
                    {row.rankNow ?? row.rankWas}
                    {moveBy !== 0 && (
                      <span class={moveBy > 0 ? 'lab-up' : 'lab-down'}>
                        {moveBy > 0 ? ` ▲${moveBy}` : ` ▼${-moveBy}`}
                      </span>
                    )}
                    {!row.was && row.now && <span class="lab-up"> new</span>}
                    {row.was && now && !row.now && <span class="lab-down"> gone</span>}
                  </td>
                  <td>
                    <span class="lab-option">{row.key}</span>
                    <span class="muted lab-id">
                      {row.id}
                      {row.learn !== row.key && ` · valued as ${row.learn}`}
                    </span>
                    {chose && <span class="lab-chip">chosen</span>}
                    {wasChosen && !chose && <span class="lab-chip lab-chip-was">was chosen</span>}
                  </td>
                  <Cell now={row.now?.value} was={row.was?.value} />
                  <Cell digits={1} now={row.now?.seconds} was={row.was?.seconds} />
                  <Cell digits={3} now={row.now?.rate} strong was={row.was?.rate} />
                  <td>
                    <label class={`lab-allow${forced !== undefined ? ' is-changed' : ''}`}>
                      <input
                        checked={!blocked(row)}
                        onChange={(e) => {
                          const block = !e.currentTarget.checked;
                          const original = row.was?.blocked ?? false;
                          setScenario(edit(scenario, 'blocked', row.id, block === original ? undefined : block));
                        }}
                        type="checkbox"
                      />
                      {blocked(row) ? 'blocked' : ''}
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ordered.length > 25 && (
        <button class="quiet" onClick={() => setAll(!all)} type="button">
          {all ? 'Show the best 25' : `Show all ${ordered.length}`}
        </button>
      )}
    </section>
  );
}

function Cell({ was, now, digits = 2, strong }: { was?: number; now?: number; digits?: number; strong?: boolean }) {
  // Moved as far as it shows: a difference past the digits shown is no news.
  const moved = now !== undefined && was !== undefined && fmt(now, digits) !== fmt(was, digits);
  const Tag = strong ? 'strong' : 'span';
  return (
    <td class="n">
      {now === undefined || !moved ? (
        <Tag>{fmt(now ?? was, digits)}</Tag>
      ) : (
        <span class="lab-delta">
          <span class="muted lab-was">{fmt(was, digits)}</span>
          <Tag class={now > (was ?? 0) ? 'lab-up' : 'lab-down'}>{fmt(now, digits)}</Tag>
        </span>
      )}
    </td>
  );
}
