import { useEffect, useMemo, useState } from 'preact/hooks';

import type { LabResident } from '../src/lab/routes';
import type { Scenario, SpanResident, SpanStatus } from '../src/lab/types';
import { api } from './api';
import { changesIn } from './lab';

// The lab's changes over a stretch: every decision of the chosen residents in the last hours made
// again with them, against what each came to made again unchanged; what each resident chose more
// and less often, and each decision that came out differently, to open in the lab.
const utc = (at: number) => new Date(at).toISOString().slice(11, 19);
const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : '—');

export function SpanPanel({
  residents,
  scenario,
  until
}: {
  residents?: LabResident[];
  scenario: Scenario;
  // The decision open in the lab, which the stretch ends at; else the pull's end.
  until?: { at: number; resident: string };
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(until ? [until.resident] : []));
  useEffect(() => {
    if (until) setChosen((c) => (c.size ? c : new Set([until.resident])));
  }, [until?.resident]);
  const [hours, setHours] = useState(1);
  const [status, setStatus] = useState<SpanStatus | null>();
  const [error, setError] = useState<string>();
  const [only, setOnly] = useState<string>('');

  useEffect(() => {
    let live = true;
    const poll = () =>
      api.lab.span().then(
        (s) => {
          if (!live) return;
          setStatus(s);
          if (s?.running) timer = setTimeout(poll, 1000);
        },
        () => {}
      );
    let timer = setTimeout(poll, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [status?.running, status?.id]);

  const runnable = residents?.filter((r) => r.kept) ?? [];
  const decisions = useMemo(() => status?.residents.reduce((n, r) => n + r.total, 0) ?? 0, [status]);
  const start = async () => {
    setError(undefined);
    try {
      await api.lab.startSpan({ residents: [...chosen], hours, scenario, ...(until ? { until: until.at } : {}) });
      setStatus(await api.lab.span());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const changes = changesIn(scenario);
  return (
    <section aria-label="Over a stretch" class="lab-span">
      <h2>Over a stretch</h2>
      <p class="muted lab-note">
        Make every decision of the chosen residents in the hours up to this decision (or the end of the pull) again with
        these {changes} change
        {changes === 1 ? '' : 's'}, against what each came to made again unchanged. Each part of a stretch begins from
        the mind as it truly was at that point; from there, the changes shape how it goes on.
      </p>
      <div class="lab-span-form">
        <fieldset>
          <legend>Residents</legend>
          {residents?.map((r) => (
            <label
              class={r.kept ? undefined : 'muted'}
              key={r.id}
              title={r.kept ? undefined : 'Run it on Choices first'}
            >
              <input
                checked={chosen.has(r.id)}
                disabled={!r.kept}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.currentTarget.checked) next.add(r.id);
                  else next.delete(r.id);
                  setChosen(next);
                }}
                type="checkbox"
              />
              {r.name}
            </label>
          ))}
          <button
            class="quiet"
            onClick={() => setChosen(new Set(chosen.size === runnable.length ? [] : runnable.map((r) => r.id)))}
            type="button"
          >
            {chosen.size === runnable.length && runnable.length ? 'None' : 'All run'}
          </button>
        </fieldset>
        <label>
          <span>{until ? `Hours up to ${utc(until.at)} UTC (this decision)` : 'Hours up to the end of the pull'}</span>
          <select onChange={(e) => setHours(Number(e.currentTarget.value))} value={hours}>
            {[0.25, 1, 3, 6, 12].map((h) => (
              <option key={h} value={h}>
                {h < 1 ? `${h * 60} minutes` : `${h} hour${h === 1 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </label>
        {status?.running ? (
          <button
            class="danger"
            onClick={() => api.lab.stopSpan().then(() => api.lab.span().then(setStatus))}
            type="button"
          >
            Stop
          </button>
        ) : (
          <button class="primary" disabled={!chosen.size || !changes} onClick={start} type="button">
            Run over the stretch
          </button>
        )}
        {!changes && <span class="muted">Make a change first.</span>}
      </div>
      {error && (
        <p class="lab-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <div class="lab-span-result">
          <p class="muted">
            {status.running ? 'Running' : 'Ran'} {changesIn(status.request.scenario)} change
            {changesIn(status.request.scenario) === 1 ? '' : 's'} over the {status.request.hours} h up to{' '}
            {status.request.until ? `${utc(status.request.until)} UTC` : 'the end of the pull'} ·{' '}
            {decisions.toLocaleString('en-GB')} decisions ·{' '}
            {Math.round(((status.finished ?? Date.now()) - status.started) / 1000)} s
          </p>
          <table class="lab-table">
            <thead>
              <tr>
                <th>Resident</th>
                <th>Progress</th>
                <th class="n">Changed</th>
                <th>Chosen more or less often</th>
              </tr>
            </thead>
            <tbody>
              {status.residents.map((r) => (
                <ResidentRow key={r.resident} only={only} onOnly={setOnly} row={r} />
              ))}
            </tbody>
          </table>
          <h3>
            Decisions that came out differently
            {only && (
              <button class="quiet" onClick={() => setOnly('')} type="button">
                all residents
              </button>
            )}
          </h3>
          <div class="scroll lab-changes">
            <table class="lab-table lab-dense">
              <thead>
                <tr>
                  <th>UTC</th>
                  <th>Resident</th>
                  <th>Was</th>
                  <th>Now</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {status.changes
                  .filter((c) => !only || c.resident === only)
                  .slice(0, 500)
                  .map((c) => (
                    <tr key={c.id}>
                      <td>{utc(c.at)}</td>
                      <td>{status.residents.find((r) => r.resident === c.resident)?.name}</td>
                      <td>{c.before}</td>
                      <td>
                        <strong>{c.after}</strong>
                      </td>
                      <td>
                        <a href={`/lab?d=${c.id}`}>open</a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function ResidentRow({ row, only, onOnly }: { row: SpanResident; only: string; onOnly: (r: string) => void }) {
  const shifts = Object.keys({ ...row.before, ...row.after })
    .map((plan) => ({ plan, d: (row.after[plan] ?? 0) - (row.before[plan] ?? 0) }))
    .filter((s) => s.d !== 0)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 4);
  return (
    <tr class={only === row.resident ? 'is-chosen' : undefined}>
      <td>
        <button class="quiet lab-link" onClick={() => onOnly(row.resident)} type="button">
          {row.name}
        </button>
        {row.error && <span class="tone-error"> {row.error}</span>}
        {row.skipped > 0 && (
          <span class="muted lab-id">{row.skipped.toLocaleString('en-GB')} earlier skipped: before its run began</span>
        )}
      </td>
      <td>
        <span class="lab-bar" title={`${row.done} of ${row.total}`}>
          <span style={{ width: `${row.total ? (100 * row.done) / row.total : 0}%` }} />
        </span>
        <span class="muted">
          {row.done.toLocaleString('en-GB')} / {row.total.toLocaleString('en-GB')}
        </span>
      </td>
      <td class="n">
        {row.changed.toLocaleString('en-GB')} <span class="muted">{pct(row.changed, row.done)}</span>
      </td>
      <td>
        {shifts.length ? (
          shifts.map((s) => (
            <span class={`lab-shift ${s.d > 0 ? 'lab-up' : 'lab-down'}`} key={s.plan}>
              {s.d > 0 ? '+' : ''}
              {s.d} {s.plan}
            </span>
          ))
        ) : (
          <span class="muted">none</span>
        )}
      </td>
    </tr>
  );
}
