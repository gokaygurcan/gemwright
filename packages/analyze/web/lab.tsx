import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { LabResident } from '../src/lab/routes';
import type { LabResponse, Scenario } from '../src/lab/types';
import { api } from './api';
import { Inputs } from './lab-inputs';
import { Options, Verdict } from './lab-options';
import { SpanPanel } from './lab-span';
import { navigate } from './router';

// The lab: one decision made again as it was and with any of its inputs, judgements or options
// changed, side by side, re-weighed as they are edited; and the same changes over a stretch of many
// decisions (lab-span.tsx). The changes stay in this browser, across decisions, until reset.
export type Weighed = LabResponse & { near: { previous?: number; next?: number } };

const STORE = 'lab.scenario';
const readScenario = (): Scenario => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Scenario;
  } catch {
    return {};
  }
};
const keepScenario = (scenario: Scenario) => {
  try {
    localStorage.setItem(STORE, JSON.stringify(scenario));
  } catch {
    // The changes then last only as long as the page.
  }
};

// How many single changes a scenario holds.
export const changesIn = (scenario: Scenario) =>
  Object.values(scenario).reduce(
    (n, part) => n + (part && typeof part === 'object' ? Object.keys(part).length : part === undefined ? 0 : 1),
    0
  );

const utc = (at: number) => new Date(at).toISOString().slice(0, 19).replace('T', ' ');

export function LabPage({ path }: { path: string }) {
  const id = Number(new URLSearchParams(path.split('?')[1]).get('d')) || undefined;
  const [residents, setResidents] = useState<LabResident[]>();
  const [scenario, setScenarioState] = useState<Scenario>(readScenario);
  const [result, setResult] = useState<Weighed>();
  const [weighing, setWeighing] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef(0);

  const setScenario = useCallback((next: Scenario) => {
    setScenarioState(next);
    keepScenario(next);
  }, []);

  useEffect(() => {
    api.lab.residents().then(setResidents, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Weighed again on every change, the last request winning.
  useEffect(() => {
    if (!id) return;
    const ticket = ++latest.current;
    setWeighing(true);
    const timer = setTimeout(() => {
      api.lab.weigh(id, scenario).then(
        (r) => {
          if (ticket !== latest.current) return;
          setResult(r);
          setError(undefined);
          setWeighing(false);
        },
        (e: unknown) => {
          if (ticket !== latest.current) return;
          setError(e instanceof Error ? e.message : String(e));
          setWeighing(false);
        }
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [id, scenario]);

  useEffect(() => {
    document.title = 'Lab · Gemwright analyzer';
    const keys = (event: KeyboardEvent) => {
      if (!(event.altKey && result)) return;
      if (event.key === 'ArrowLeft' && result.near.previous) navigate(`/lab?d=${result.near.previous}`);
      if (event.key === 'ArrowRight' && result.near.next) navigate(`/lab?d=${result.near.next}`);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [result]);

  const shown = result?.original.id === id ? result : undefined;
  const resident = useMemo(
    () => residents?.find((r) => r.id === shown?.original.resident),
    [residents, shown?.original.resident]
  );

  return (
    <article class="lab">
      <header class="lab-head">
        <div>
          <h1>Lab</h1>
          <p class="muted">
            Change any input, judgement or option of a decision and see what it would have done instead. Edits re-weigh
            as you type; they stay in this browser until you reset them.
          </p>
        </div>
        <Picker id={id} resident={resident?.id ?? shown?.original.resident} residents={residents} />
      </header>
      {error && (
        <p class="lab-error" role="alert">
          {error}
        </p>
      )}
      {!id && <Start residents={residents} />}
      {id && !shown && !error && <p class="muted">Making decision #{id} again…</p>}
      {shown && (
        <>
          <div class="lab-decision">
            <div class="lab-nav">
              <button
                disabled={!shown.near.previous}
                onClick={() => navigate(`/lab?d=${shown.near.previous}`)}
                title="Previous decision (Alt+←)"
                type="button"
              >
                ← Previous
              </button>
              <div class="lab-which">
                <strong>
                  {shown.original.name} · {shown.original.kind === 'considered' ? 'choice' : 'second thought'} #
                  {shown.original.id}
                </strong>
                <span class="muted">
                  {utc(shown.original.at)} UTC · woken by {shown.original.trigger}
                  {shown.original.position && ` · at ${shown.original.position.x},${shown.original.position.y}`}
                  {shown.original.plan && ` · under way: ${shown.original.plan}`} ·{' '}
                  <a href={`/choice/${shown.original.id}`}>its page</a>
                </span>
              </div>
              <button
                disabled={!shown.near.next}
                onClick={() => navigate(`/lab?d=${shown.near.next}`)}
                title="Next decision (Alt+→)"
                type="button"
              >
                Next →
              </button>
            </div>
            <Verdict onReset={() => setScenario({})} result={shown} scenario={scenario} weighing={weighing} />
          </div>
          <div class="lab-grid">
            <Inputs result={shown} scenario={scenario} setScenario={setScenario} />
            <Options result={shown} scenario={scenario} setScenario={setScenario} weighing={weighing} />
          </div>
        </>
      )}
      <SpanPanel
        residents={residents}
        scenario={scenario}
        until={shown && { at: shown.original.at, resident: shown.original.resident }}
      />
    </article>
  );
}

function Picker({ id, residents, resident }: { id?: number; residents?: LabResident[]; resident?: string }) {
  const [chosen, setChosen] = useState(resident ?? '');
  const [when, setWhen] = useState('');
  const [typed, setTyped] = useState('');
  useEffect(() => setChosen(resident ?? ''), [resident]);
  const go = async () => {
    if (typed.trim()) return navigate(`/lab?d=${Number(typed.replace('#', ''))}`);
    const r = residents?.find((x) => x.id === chosen);
    if (!r) return;
    if (!when) return r.last && navigate(`/lab?d=${r.last}`);
    const found = await api.lab.at(r.id, Date.parse(`${when}Z`));
    if (found.id) navigate(`/lab?d=${found.id}`);
  };
  return (
    <form
      class="lab-picker"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <label>
        <span>Resident</span>
        <select onChange={(e) => setChosen(e.currentTarget.value)} value={chosen}>
          <option value="">Choose…</option>
          {residents?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {r.kept ? '' : ' (not run yet)'}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>At (UTC)</span>
        <input onInput={(e) => setWhen(e.currentTarget.value)} step="1" type="datetime-local" value={when} />
      </label>
      <label>
        <span>or decision</span>
        <input
          inputMode="numeric"
          onInput={(e) => setTyped(e.currentTarget.value)}
          placeholder={id ? `#${id}` : '#'}
          value={typed}
        />
      </label>
      <button class="primary" type="submit">
        Open
      </button>
    </form>
  );
}

function Start({ residents }: { residents?: LabResident[] }) {
  if (!residents) return <p class="muted">Loading residents…</p>;
  return (
    <section class="lab-start">
      <h2>Pick a resident’s latest decision</h2>
      <ul>
        {residents.map((r) => (
          <li key={r.id}>
            {r.kept ? (
              <a href={`/lab?d=${r.last}`}>{r.name}</a>
            ) : (
              <span>
                {r.name}{' '}
                <span class="muted">
                  — run it on <a href="/choices">Choices</a> first
                </span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
