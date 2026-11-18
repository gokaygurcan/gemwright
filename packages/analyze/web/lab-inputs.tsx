import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

import type { Scenario, SpawnerBelief } from '../src/lab/types';
import type { Weighed } from './lab';

// Everything a decision took in, each part editable: the AI's judgements, its traits and self, what
// it took each mobile in view for, what it believed of each spawner, what it expected doing each
// thing to bring, how sure it was each plan succeeds, and what the encounter answered. An edit shows
// beside what it was, and resets on its own.
type Set = (next: Scenario) => void;
type Keyed = 'tuning' | 'traits' | 'identities' | 'appraisals' | 'chances' | 'answers' | 'spawners' | 'blocked';

// A scenario with one part set, or taken out when undefined (and a section left empty dropped).
export function edit(scenario: Scenario, section: Keyed, key: string, value: unknown): Scenario {
  const part = { ...((scenario[section] as Record<string, unknown> | undefined) ?? {}) };
  if (value === undefined) delete part[key];
  else part[key] = value;
  const next = { ...scenario, [section]: part };
  if (!Object.keys(part).length) delete next[section];
  return next;
}
const setTop = (scenario: Scenario, key: 'health' | 'funds' | 'position', value: unknown): Scenario => {
  const next = { ...scenario, [key]: value };
  if (value === undefined) delete next[key];
  return next;
};
const number = (text: string) => (text.trim() === '' || !Number.isFinite(Number(text)) ? undefined : Number(text));
const fmt = (n: number | null | undefined, digits = 3) =>
  n === null || n === undefined ? '—' : Number(n.toFixed(digits)).toLocaleString('en-GB');

const TUNING: Record<string, [string, string]> = {
  seekRange: ['Seek range', 'Tiles from a spawner it walks to before it looks.'],
  sight: ['Sight', 'Tiles it sees: a spawner nearer needs no going to.'],
  spawnerPrior: ['Spawner prior', 'Visits the shard’s word on a spawner counts as.'],
  walkPace: ['Starting walk pace', 'Tiles a second until it has been seen to walk.'],
  refillScale: ['Spawner refill ×', 'How long a spawner seen empty takes to fill, as a share of its delay.'],
  chancePrior: ['Plan success prior', 'Tries and successes a plan starts with.'],
  changeCourseBelow: ['Change course at or below', 'A best rate this low is no work: it changes course.'],
  patienceScale: ['Patience ×', 'How much better another plan must be to leave the one under way.']
};

function Section({
  title,
  changed,
  open = false,
  children,
  note
}: {
  title: string;
  changed: number;
  open?: boolean;
  note?: string;
  children: ComponentChildren;
}) {
  return (
    <details class="lab-section" open={open || changed > 0}>
      <summary>
        <span>{title}</span>
        {changed > 0 && <span class="lab-badge">{changed} changed</span>}
      </summary>
      {note && <p class="muted lab-note">{note}</p>}
      {children}
    </details>
  );
}

function NumberField({
  value,
  was,
  onChange,
  step = 'any',
  min,
  max,
  wide
}: {
  value: number | undefined;
  was: number | null | undefined;
  onChange: (value: number | undefined) => void;
  step?: string;
  min?: number;
  max?: number;
  wide?: boolean;
}) {
  const [text, setText] = useState<string>();
  const changed = value !== undefined;
  return (
    <span class={`lab-field${changed ? ' is-changed' : ''}`}>
      <input
        class={wide ? 'wide' : undefined}
        inputMode="decimal"
        max={max}
        min={min}
        onBlur={() => setText(undefined)}
        onInput={(e) => {
          setText(e.currentTarget.value);
          onChange(number(e.currentTarget.value));
        }}
        placeholder={fmt(was)}
        step={step}
        type="number"
        value={text ?? (changed ? String(value) : '')}
      />
      {changed && (
        <button
          class="lab-reset"
          onClick={() => {
            setText(undefined);
            onChange(undefined);
          }}
          title={`Back to ${fmt(was)}`}
          type="button"
        >
          ↺
        </button>
      )}
    </span>
  );
}

function Answer({ value, onChange }: { value: boolean | undefined; onChange: (v: boolean | undefined) => void }) {
  return (
    <select
      class={value !== undefined ? 'is-changed' : undefined}
      onChange={(e) => onChange(e.currentTarget.value === '' ? undefined : e.currentTarget.value === 'yes')}
      value={value === undefined ? '' : value ? 'yes' : 'no'}
    >
      <option value="">as it was</option>
      <option value="yes">yes</option>
      <option value="no">no</option>
    </select>
  );
}

export function Inputs({ result, scenario, setScenario }: { result: Weighed; scenario: Scenario; setScenario: Set }) {
  const o = result.original;
  const now = result.changed ?? o;
  const [filter, setFilter] = useState('');
  const count = (part?: object) => (part ? Object.keys(part).length : 0);
  const selfChanged =
    Number(scenario.health !== undefined) + Number(scenario.funds !== undefined) + Number(!!scenario.position);
  const spawners = o.spawners.filter(
    (s) => !filter || `${s.kind} ${s.x},${s.y}`.toLowerCase().includes(filter.toLowerCase())
  );
  const nowSpawner = new Map(now.spawners.map((s) => [s.key, s]));
  const belief = (key: string, field: keyof SpawnerBelief, value: unknown) => {
    const current = { ...(scenario.spawners?.[key] ?? {}), [field]: value };
    if (value === undefined) delete current[field];
    setScenario(edit(scenario, 'spawners', key, Object.keys(current).length ? current : undefined));
  };
  const questions = Object.keys({ ...o.answers, ...(result.changed?.answers ?? {}) }).sort();
  return (
    <section aria-label="Inputs" class="lab-inputs">
      <h2>What it took in</h2>
      <Section changed={count(scenario.tuning)} open title="Judgements (AI constants and rules)">
        <table class="lab-table">
          <tbody>
            {Object.entries(TUNING).map(([key, [label, help]]) => (
              <tr key={key}>
                <th scope="row">
                  {label}
                  <small class="muted">{help}</small>
                </th>
                <td>
                  <NumberField
                    onChange={(v) => setScenario(edit(scenario, 'tuning', key, v))}
                    value={scenario.tuning?.[key]}
                    was={o.tuning[key]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section changed={count(scenario.traits)} title="Traits">
        <table class="lab-table">
          <tbody>
            {Object.entries(o.traits).map(([trait, was]) => (
              <tr key={trait}>
                <th scope="row">{trait}</th>
                <td class="lab-slider">
                  <input
                    aria-label={trait}
                    max={1}
                    min={0}
                    onInput={(e) => setScenario(edit(scenario, 'traits', trait, Number(e.currentTarget.value)))}
                    step={0.001}
                    type="range"
                    value={scenario.traits?.[trait] ?? was}
                  />
                  <NumberField
                    max={1}
                    min={0}
                    onChange={(v) => setScenario(edit(scenario, 'traits', trait, v))}
                    step="0.001"
                    value={scenario.traits?.[trait]}
                    was={was}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section changed={selfChanged} title="Itself">
        <table class="lab-table">
          <tbody>
            <tr>
              <th scope="row">
                Hits <small class="muted">of {fmt(o.health.max, 0)}</small>
              </th>
              <td>
                <NumberField
                  min={0}
                  onChange={(v) => setScenario(setTop(scenario, 'health', v))}
                  step="1"
                  value={scenario.health}
                  was={o.health.current}
                />
              </td>
            </tr>
            <tr>
              <th scope="row">Gold it can spend</th>
              <td>
                <NumberField
                  min={0}
                  onChange={(v) => setScenario(setTop(scenario, 'funds', v))}
                  step="1"
                  value={scenario.funds}
                  was={o.funds}
                />
              </td>
            </tr>
            {(['x', 'y'] as const).map((axis) => (
              <tr key={axis}>
                <th scope="row">Standing at {axis}</th>
                <td>
                  <NumberField
                    onChange={(v) => {
                      const next = {
                        x: scenario.position?.x ?? o.position?.x ?? 0,
                        y: scenario.position?.y ?? o.position?.y ?? 0,
                        [axis]: v ?? o.position?.[axis] ?? 0
                      };
                      const same = next.x === o.position?.x && next.y === o.position?.y;
                      setScenario(setTop(scenario, 'position', same ? undefined : next));
                    }}
                    step="1"
                    value={
                      scenario.position && scenario.position[axis] !== o.position?.[axis]
                        ? scenario.position[axis]
                        : undefined
                    }
                    was={o.position?.[axis]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section
        changed={count(scenario.identities)}
        note="What it takes each mobile in view for: kinds separated by /, as Brigand/Person."
        title={`In view (${o.sightings.length})`}
      >
        <table class="lab-table">
          <thead>
            <tr>
              <th>Serial</th>
              <th class="n">Tiles</th>
              <th>Taken for</th>
              <th>May attack</th>
            </tr>
          </thead>
          <tbody>
            {o.sightings.map((s) => {
              const key = String(s.serial);
              const question = `allows ${s.serial}`;
              return (
                <tr key={key}>
                  <td>{s.serial}</td>
                  <td class="n">{s.away ?? '—'}</td>
                  <td>
                    <span class={`lab-field${scenario.identities?.[key] !== undefined ? ' is-changed' : ''}`}>
                      <input
                        class="wide"
                        onInput={(e) =>
                          setScenario(edit(scenario, 'identities', key, e.currentTarget.value.trim() || undefined))
                        }
                        placeholder={s.name || '(unnamed)'}
                        value={scenario.identities?.[key] ?? ''}
                      />
                    </span>
                  </td>
                  <td>
                    {question in o.answers || scenario.answers?.[question] !== undefined ? (
                      <span class="lab-answer">
                        <span class="muted">
                          {o.answers[question] === undefined ? '—' : o.answers[question] ? 'yes' : 'no'}
                        </span>
                        <Answer
                          onChange={(v) => setScenario(edit(scenario, 'answers', question, v))}
                          value={scenario.answers?.[question]}
                        />
                      </span>
                    ) : (
                      <span class="muted">not asked</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section
        changed={count(scenario.spawners)}
        note="What it believes of each kind at each spawner it could go to: its chance there comes from these."
        title={`Spawners (${o.spawners.length})`}
      >
        <input
          aria-label="Filter spawners"
          class="lab-filter"
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter by kind or place"
          type="search"
          value={filter}
        />
        <div class="scroll">
          <table class="lab-table lab-dense">
            <thead>
              <tr>
                <th>Kind at</th>
                <th class="n">Walk s</th>
                <th class="n">Chance</th>
                <th class="n">Visits</th>
                <th class="n">Finds</th>
                <th>Empty</th>
                <th class="n">Left s ago</th>
              </tr>
            </thead>
            <tbody>
              {spawners.slice(0, 200).map((s) => {
                const changed = scenario.spawners?.[s.key];
                const chance = nowSpawner.get(s.key)?.chance;
                return (
                  <tr class={changed ? 'is-changed-row' : undefined} key={s.key}>
                    <td>
                      {s.kind}{' '}
                      <span class="muted">
                        {s.x},{s.y}
                      </span>
                    </td>
                    <td class="n">{fmt(s.walk, 0)}</td>
                    <td class="n">
                      {fmt(s.chance)}
                      {chance !== undefined && chance !== s.chance && <span class="lab-now"> → {fmt(chance)}</span>}
                    </td>
                    <td class="n">
                      <NumberField
                        min={0}
                        onChange={(v) => belief(s.key, 'visits', v)}
                        step="1"
                        value={changed?.visits}
                        was={s.visits}
                      />
                    </td>
                    <td class="n">
                      <NumberField
                        min={0}
                        onChange={(v) => belief(s.key, 'finds', v)}
                        step="1"
                        value={changed?.finds}
                        was={s.finds}
                      />
                    </td>
                    <td>
                      <select
                        class={changed?.empty !== undefined ? 'is-changed' : undefined}
                        onChange={(e) =>
                          belief(
                            s.key,
                            'empty',
                            e.currentTarget.value === '' ? undefined : e.currentTarget.value === 'yes'
                          )
                        }
                        value={changed?.empty === undefined ? '' : changed.empty ? 'yes' : 'no'}
                      >
                        <option value="">{s.empty ? 'yes' : 'no'}</option>
                        <option value="yes">yes</option>
                        <option value="no">no</option>
                      </select>
                    </td>
                    <td class="n">
                      <NumberField
                        min={0}
                        onChange={(v) => belief(s.key, 'leftAgo', v)}
                        step="1"
                        value={changed?.leftAgo}
                        was={s.leftAgo}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <Section
        changed={count(scenario.appraisals)}
        note="What it expects doing each thing to bring, before travel: the value its options start from."
        title={`Expectations (${o.appraisals.length})`}
      >
        <table class="lab-table">
          <thead>
            <tr>
              <th>Doing</th>
              <th class="n">Tries</th>
              <th class="n">Worth</th>
              <th class="n">Seconds</th>
            </tr>
          </thead>
          <tbody>
            {o.appraisals.map((a) => {
              const changed = scenario.appraisals?.[a.learn];
              const set = (field: 'value' | 'seconds', v: number | undefined) => {
                const next = { ...(changed ?? {}), [field]: v };
                if (v === undefined) delete next[field];
                setScenario(edit(scenario, 'appraisals', a.learn, Object.keys(next).length ? next : undefined));
              };
              return (
                <tr key={a.learn}>
                  <td>{a.learn}</td>
                  <td class="n">{a.n}</td>
                  <td class="n">
                    <NumberField onChange={(v) => set('value', v)} value={changed?.value} was={a.value} />
                  </td>
                  <td class="n">
                    <NumberField min={0} onChange={(v) => set('seconds', v)} value={changed?.seconds} was={a.seconds} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section
        changed={count(scenario.chances)}
        note="How sure it is each plan succeeds, from how its tries went: 1 when it has none."
        title={`Plan chances (${Object.keys(o.chances).length})`}
      >
        <table class="lab-table">
          <tbody>
            {Object.entries(o.chances).map(([plan, was]) => (
              <tr key={plan}>
                <th scope="row">{plan}</th>
                <td>
                  <NumberField
                    max={1}
                    min={0}
                    onChange={(v) => setScenario(edit(scenario, 'chances', plan, v))}
                    step="0.01"
                    value={scenario.chances?.[plan]}
                    was={was}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section
        changed={questions.filter((q) => !q.startsWith('allows ') && scenario.answers?.[q] !== undefined).length}
        note="What the encounter said each kind is beatable, as asked while weighing (per mobile, under In view)."
        title="Encounter"
      >
        <table class="lab-table">
          <tbody>
            {questions
              .filter((q) => !q.startsWith('allows '))
              .map((q) => (
                <tr key={q}>
                  <th scope="row">
                    {q.replace('allowsKind ', 'May attack a ')}
                    <small class="muted">
                      was {o.answers[q] === undefined ? 'not asked' : o.answers[q] ? 'yes' : 'no'}
                    </small>
                  </th>
                  <td>
                    <Answer
                      onChange={(v) => setScenario(edit(scenario, 'answers', q, v))}
                      value={scenario.answers?.[q]}
                    />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Section>
    </section>
  );
}
