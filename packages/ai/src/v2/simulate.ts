import type { Encounter } from './encounter';
import { type Answer, TapedEncounter } from './encounter';
import type { History, HistoryEvent, Wake } from './history';
import type { Mind } from './mind';
import { deliberate, digest, type Valued, weighed } from './planning';
import { reachOver } from './reach';
import { awaken, placesOf } from './shadow';
import { learnRoute } from './unreachable';

export interface Trace {
  from: number;
  now: number;
  slices: [steps: number, mark: number, now: number][];
  tape: Answer[];
  // The plan a second thought weighed against, as far as it had come.
  active?: Parameters<typeof deliberate>[4];
  digest?: string;
  weighed?: [id: string, value: number, rate: number, seconds: number][];
}

type Option = { id: string; key: string; value: number; rate: number; seconds: number };

export interface Simulation {
  id: number;
  resident: string;
  kind: string;
  at: number;
  wake: { id: number; at: number; restored: boolean };
  // Events re-lived to reach the moment it began weighing, and met while it weighed.
  relived: number;
  // Where it believed it stood when it began, live and simulated.
  stood: { live?: HistoryEvent['where']; simulated?: unknown };
  during: number;
  same: boolean;
  recorded: { digest?: string; options: Option[] };
  simulated: { digest?: string; options: Option[] };
  // Questions the encounter was never asked live: the simulation took a different path to them.
  unanswered: string[];
  // Where the two weighings first part: the option at that place in each.
  parted?: { at: number; live?: unknown[]; simulated?: unknown[] };
  ms: number;
}

// What the live mind did itself rather than observe, done again the same way: each wrote it down.
const applied: Record<string, (mind: Mind, data: Record<string, unknown>, at: number) => void> = {
  executed: (mind, data) => mind.complete(String(data.id), data.succeeded === true),
  'resource-spent': (mind, data, at) =>
    mind.exhausted({
      ...(data as { x: number; y: number; width: number; height: number }),
      respawn: Number(data.until) - at
    }),
  'drop-refused': (mind, data) => mind.refuseDrop(Number(data.serial)),
  'spell-missing': (mind, data) => mind.refuseSpell(Number(data.spell)),
  movement: (mind, data) =>
    mind.locomotion.observed(String(data.key), Number(data.steps), Number(data.seconds), Number(data.stamina))
};

// One decision (a `considered` or `reconsidered` event) weighed again from what the resident knew
// then: its mind rebuilt from the waking it began in, the same history re-lived as it was met, the
// clock as it was, and the encounter's answers as they were given. The same weighing comes to the
// same result; where it does not, what differs is shown.
// A resident's mind rebuilt from a waking, up to event `through`: its checkpoint restored, its
// history re-lived as it did on waking, then each later event met as the live mind met it.
function rebuild(history: History, wake: Wake, through: number, clock: { now: number }) {
  for (const event of history.recent('route-failed', 0, through)) learnRoute(event, history.path);
  const { mind, places, terrain, relive } = awaken(history, wake, () => {});
  let relived = 0;
  for (const event of relive()) {
    mind.observe(event);
    relived++;
  }
  mind.awake = true;
  // As the live mind met each event after waking: perceived, noticed, done itself, or only told.
  const meet = (event: HistoryEvent) => {
    clock.now = event.at;
    if (event.via === 'perceived') places.observe(event);
    if (event.via === 'perceived' || event.via === 'noticed') mind.observe(event);
    else if (event.via === 'told') {
      applied[event.kind]?.(mind, event.data as Record<string, unknown>, event.at);
      if (event.kind === 'life-started') mind.acting = true;
    }
  };
  for (const event of history.between(wake.resident, wake.through, through)) {
    meet(event);
    relived++;
  }
  return { mind, terrain, meet, relived };
}

// Whether re-living rebuilds the mind the live one was: each waking's mind rebuilt up to the next
// waking's checkpoint, against the checkpoint the live mind saved then. What differs, by part.
export function checkWakes(history: History, resident: string) {
  const wakes = history.wakes(resident);
  const report: { wake: number; through: number; differs: string[] }[] = [];
  const realNow = Date.now;
  try {
    for (const [i, wake] of wakes.entries()) {
      const next = wakes[i + 1];
      if (!next?.state || next.after <= wake.through) continue;
      const clock = { now: wake.at };
      Date.now = () => clock.now;
      const { mind } = rebuild(history, wake, next.after, clock);
      report.push({ wake: wake.id, through: next.after, differs: differences(mind.snapshot(), next.state) });
    }
  } finally {
    Date.now = realNow;
  }
  return report;
}

function differences(a: unknown, b: unknown, path = ''): string[] {
  const plain = (v: unknown) =>
    v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), x])) : v instanceof Set ? [...v] : v;
  const x = plain(a);
  const y = plain(b);
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null)
    return Object.is(x, y)
      ? []
      : [`${path || '.'}: ${JSON.stringify(x)?.slice(0, 80)} ≠ ${JSON.stringify(y)?.slice(0, 80)}`];
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  const found: string[] = [];
  for (const key of keys) {
    found.push(
      ...differences((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], `${path}.${key}`)
    );
    if (found.length > 40) break;
  }
  return found;
}

export function simulate(history: History, id: number): Simulation {
  const started = performance.now();
  const decision = history.event(id);
  if (!decision || (decision.kind !== 'considered' && decision.kind !== 'reconsidered'))
    throw new Error(`Event ${id} is not a decision.`);
  const data = decision.data as { trace?: Trace; options?: Option[]; alternative?: Option };
  const trace = data.trace;
  if (!trace) throw new Error(`Decision ${id} was made before decisions were traced.`);
  const resident = decision.resident;
  const wake = history.wakeBefore(resident, trace.from + 1);
  if (!wake) throw new Error(`No waking of ${resident} is recorded before decision ${id}.`);
  const clock = { now: wake.at };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const { mind, terrain, meet, relived } = rebuild(history, wake, trace.from, clock);
    let met = trace.from;
    const encounter = new TapedEncounter(trace.tape);
    mind.encounter = encounter as unknown as Encounter;
    const reach = terrain && reachOver(terrain);
    if (reach) mind.steps = reach.steps;
    clock.now = trace.now;
    const stood = mind.position;
    const work = deliberate(mind, terrain, new Set(), placesOf(history, mind), trace.active);
    let steps = 0;
    let during = 0;
    let valued: Valued[] | undefined;
    // Up to each point it let the session run, then what happened meanwhile, at the time it resumed.
    for (const [until, mark, at] of trace.slices) {
      while (steps < until && !valued) {
        const next = work.next();
        steps++;
        if (next.done) valued = next.value;
      }
      for (const event of history.between(resident, met, mark)) {
        meet(event);
        during++;
      }
      met = Math.max(met, mark);
      clock.now = at;
    }
    while (!valued) {
      const next = work.next();
      if (next.done) valued = next.value;
    }
    const brief = (o: Option) => ({ id: o.id, key: o.key, value: o.value, rate: o.rate, seconds: o.seconds });
    const recorded = data.options ?? (data.alternative ? [data.alternative] : []);
    const simulated = valued.slice(0, Math.max(5, recorded.length)).map(brief);
    const same = trace.digest !== undefined && trace.digest === digest(valued);
    return {
      id,
      resident,
      kind: decision.kind,
      at: decision.at,
      wake: { id: wake.id, at: wake.at, restored: !!wake.state },
      relived,
      stood: { live: decision.where, simulated: stood },
      during,
      same,
      recorded: { digest: trace.digest, options: recorded.map(brief) },
      simulated: { digest: digest(valued), options: simulated },
      unanswered: [...encounter.unanswered],
      parted: partedAt(trace.weighed, weighed(valued) ?? []),
      ms: Math.round(performance.now() - started)
    };
  } finally {
    Date.now = realNow;
  }
}

function partedAt(live: readonly unknown[][] | undefined, simulated: readonly unknown[][]) {
  if (!live) return undefined;
  for (let at = 0; at < Math.max(live.length, simulated.length); at++)
    if (JSON.stringify(live[at]) !== JSON.stringify(simulated[at]))
      return { at, live: live[at], simulated: simulated[at] };
  return undefined;
}
