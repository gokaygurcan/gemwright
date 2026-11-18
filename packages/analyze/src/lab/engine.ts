import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';

import type { Encounter } from '../../../ai/src/encounter';
import { TapedEncounter } from '../../../ai/src/encounter';
import { History, type HistoryEvent, type Wake } from '../../../ai/src/history';
import { prepareLand } from '../../../ai/src/land';
import type { Mind } from '../../../ai/src/mind';
import { deliberate, digest, type Valued } from '../../../ai/src/planning';
import { reachOver } from '../../../ai/src/reach';
import { awaken, placesOf } from '../../../ai/src/shadow';
import type { Trace } from '../../../ai/src/simulate';
import { tune, tuning } from '../../../ai/src/tuning';
import { learnRoute } from '../../../ai/src/unreachable';
import { applyScenario, choose, inputsOf, type Watch, watch } from './scenario';
import type { LiveDecision, Scenario, Weighing } from './types';

// One resident's decisions made again in order by one mind, as the AI's own simulation (packages/ai
// simulate.ts) makes one: its waking rebuilt once, each event met as the live mind met it, on the
// clock it met it, and each weighing given the encounter's answers as given live. At each later
// waking the mind wakes again as the live one did: from the checkpoint it restored when still kept,
// else from this mind as it stood where that checkpoint was taken. A chain can be kept (`save`) and
// taken up again where it stood (`Chain.from`), and any decision weighed with a scenario changed.

export type Recorded = {
  trace?: Trace;
  trigger?: string;
  doing?: string;
  id?: string;
  options?: LiveDecision['options'];
  kept?: boolean;
  keeping?: number;
  alternative?: { id: string; key: string; rate: number };
};
export type Row = { id: number; at: number; kind: string; data: string };
// The longest a failed route is remembered (packages/ai hands.ts): a day.
const ROUTES_HOLD = 24 * 3_600_000;

// What the live mind did itself rather than observe, done again the same way (simulate.ts).
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

// The land and history a pull's residents lived in (its <pull>/land folder), and the clock every
// mind in this process runs on.
export class Land {
  readonly history: History;
  readonly db: Database;
  readonly clock = { now: 0 };
  private scopes = 0;

  private constructor(readonly data: string) {
    this.history = new History(join(data, 'history.sqlite'), true);
    this.db = new Database(join(data, 'history.sqlite'), { readonly: true });
    Date.now = () => this.clock.now;
  }

  static async open(data: string) {
    const shard = (await Bun.file(join(data, 'gemwright.json')).json()) as { ai?: { cities?: string[] } };
    await prepareLand(data, shard.ai?.cities);
    return new Land(data);
  }

  // A scope of its own for each mind's knowledge of failed routes: one taken up at an earlier
  // moment knows none learned after it.
  scope() {
    return `${this.history.path}#${++this.scopes}`;
  }

  decision(id: number) {
    return this.db
      .query<Row & { resident: string }, [number]>(
        "SELECT id, at, kind, data, resident FROM events WHERE id = ? AND kind IN ('considered', 'reconsidered')"
      )
      .get(id);
  }

  decisions(resident: string, since: number, until: number) {
    return this.db
      .query<Row, [string, number, number]>(
        "SELECT id, at, kind, data FROM events WHERE resident = ? AND kind IN ('considered', 'reconsidered') AND at >= ? AND at <= ? ORDER BY id"
      )
      .all(resident, since, until);
  }

  // A resident's decisions from one (itself included) up to another (not), by when they were made.
  between(resident: string, from: number, before: number) {
    const at = (id: number) =>
      this.db.query<{ at: number }, [number]>('SELECT at FROM events WHERE id = ?').get(id)?.at;
    const [start, end] = [at(from), at(before)];
    if (start === undefined || end === undefined) return [];
    return this.decisions(resident, start, end).filter((d) => d.id >= from && d.id < before);
  }

  close() {
    this.db.close();
    this.history.close();
  }
}

// A chain taken up where it stood: the mind, how far it had met, and its waking.
export interface Saved {
  resident: string;
  decision: number;
  met: number;
  wake: Omit<Wake, 'state'>;
  state: object;
  // What the snapshot leaves out: whether its life had started (live.ts sets it on life-started),
  // and what its places know of what is in view now.
  acting: boolean;
  seeing: { names: [number, string][]; here?: { x: number; y: number } };
  // And what the mind keeps between weighings outside its snapshot (mind.ts).
  between: Between;
  // The ways it had measured: each cell's steps from the spot it entered that cell at.
  reach: { cell: number; from: Spot; known: [number, number | undefined][] }[];
  // The minds it keeps for later wakings to wake from, and where it is yet to keep one.
  carried: [number, object][];
  pending: number[];
}

// What a mind (packages/ai mind.ts) keeps between weighings outside its snapshot: how often it
// noticed a change and what changed last, the creatures it reckons with, how often prices moved, and
// its holdings as last counted.
const BETWEEN = ['noticed', 'creatures', 'changedBy', 'priced', 'held'] as const;
type Between = Partial<Record<(typeof BETWEEN)[number], unknown>>;
// How far places are, as its reach (packages/ai reach.ts) measured them: from the spot it entered
// its cell at, and the cell before, kept until it changes cell. A reach measured afresh from where it
// stands would measure other steps.
type Spot = { x: number; y: number; z: number };
type Measured = { cell: number; to: (spot: Spot) => number; known: Map<number, number | undefined> };
type Measuring = {
  here?: Measured;
  previous?: Measured;
  graph: { from(start: Spot): (spot: Spot) => number };
  stand(spot: Spot): Spot | undefined;
  steps: (from: Spot, to: Spot) => number | undefined;
};
// What places (packages/ai places.ts) know of what is in view, outside their snapshot.
type Seeing = { names: Map<number, string>; here?: { x: number; y: number } };

export interface WakeReport {
  wake: number;
  at: number;
  through: number;
  after: number;
  mode: 'checkpoint' | 'carried' | 'birth';
  relived: number;
  differs?: string[];
  ms: number;
}

export class Chain {
  mind?: Mind;
  private places?: ReturnType<typeof awaken>['places'];
  private terrain: ReturnType<typeof awaken>['terrain'];
  met = 0;
  current?: Omit<Wake, 'state'>;
  private learned = 0;
  private scope = '';
  private readonly wakes: Wake[];
  // The mind as it stood where each later waking's checkpoint was taken, to wake it from.
  private readonly pending = new Set<number>();
  private readonly carried = new Map<number, object>();
  private measuring?: Measuring;
  // The spot each measured cell was entered at.
  private readonly origins = new WeakMap<Measured, Spot>();

  constructor(
    readonly land: Land,
    readonly resident: string,
    // Each waking as it is woken.
    private readonly woke: (report: WakeReport) => void = () => {}
  ) {
    this.wakes = land.history.wakes(resident);
  }

  // Taken up where a saved chain stood, from a copy of it: a mind restored keeps what it is given and
  // changes it as it goes on.
  static from(land: Land, kept: Saved) {
    const saved = deserialize(serialize(kept)) as Saved;
    const chain = new Chain(land, saved.resident);
    chain.awake({ ...saved.wake, through: saved.met, after: saved.met }, saved.state);
    chain.met = saved.met;
    chain.current = saved.wake;
    if (chain.mind) {
      chain.mind.acting = saved.acting;
      Object.assign(chain.mind, deserialize(serialize(saved.between)));
    }
    const reach = chain.measuring;
    if (reach) {
      const [here, previous] = saved.reach.map((m): Measured | undefined => {
        const start = reach.stand(m.from);
        if (!start) return undefined;
        const measured = { cell: m.cell, to: reach.graph.from(start), known: new Map(m.known) };
        chain.origins.set(measured, m.from);
        return measured;
      });
      reach.here = here;
      reach.previous = previous;
    }
    const places = chain.places as unknown as Seeing | undefined;
    if (places) {
      for (const [serial, name] of saved.seeing.names) places.names.set(serial, name);
      places.here = saved.seeing.here;
    }
    for (const [at, state] of saved.carried) chain.carried.set(at, state);
    for (const at of saved.pending) chain.pending.add(at);
    return chain;
  }

  save(decision: number): Saved {
    if (!this.mind || !this.current) throw new Error('Nothing to save: the chain has not woken.');
    return {
      resident: this.resident,
      decision,
      met: this.met,
      wake: this.current,
      state: deserialize(serialize(this.mind.snapshot())) as object,
      acting: this.mind.acting,
      between: deserialize(
        serialize(Object.fromEntries(BETWEEN.map((key) => [key, (this.mind as unknown as Between)[key]])))
      ) as Between,
      seeing: {
        names: [...((this.places as unknown as Seeing | undefined)?.names ?? [])],
        here: (this.places as unknown as Seeing | undefined)?.here
      },
      carried: deserialize(serialize([...this.carried])) as [number, object][],
      pending: [...this.pending],
      reach: [this.measuring?.here, this.measuring?.previous].flatMap((m) => {
        const from = m && this.origins.get(m);
        return m && from ? [{ cell: m.cell, from, known: [...m.known] }] : [];
      })
    };
  }

  // Route failures any resident met, up to an event, that still hold now: what the live process knew,
  // whatever moment a chain is taken up at (none holds longer than ROUTES_HOLD).
  private learn(through: number) {
    const rows = this.learned
      ? this.land.db
          .query<{ resident: string; at: number; data: string }, [number, number]>(
            "SELECT resident, at, data FROM events WHERE kind = 'route-failed' AND id > ? AND id <= ? ORDER BY id"
          )
          .all(this.learned, through)
      : this.land.db
          .query<{ resident: string; at: number; data: string }, [number, number]>(
            "SELECT resident, at, data FROM events WHERE kind = 'route-failed' AND at > ? AND id <= ? ORDER BY id"
          )
          .all(this.land.clock.now - ROUTES_HOLD, through);
    for (const r of rows) {
      const data = JSON.parse(r.data) as { until?: number };
      if (this.learned || Number(data.until) > this.land.clock.now)
        learnRoute({ resident: r.resident, at: r.at, kind: 'route-failed', data }, this.scope);
    }
    this.learned = Math.max(this.learned, through);
  }

  private keep(upTo: number) {
    for (const at of this.pending)
      if (at <= upTo && this.mind) {
        this.carried.set(at, deserialize(serialize(this.mind.snapshot())) as object);
        this.pending.delete(at);
      }
  }

  private meet(event: HistoryEvent & { id: number }) {
    this.keep(event.id - 1);
    this.land.clock.now = event.at;
    const { mind, places } = this;
    if (!mind || !places) return;
    if (event.via === 'perceived') places.observe(event);
    if (event.via === 'perceived' || event.via === 'noticed') mind.observe(event);
    else if (event.via === 'told') {
      applied[event.kind]?.(mind, event.data as Record<string, unknown>, event.at);
      if (event.kind === 'life-started') mind.acting = true;
    }
  }

  meetThrough(through: number) {
    for (const event of this.land.history.between(this.resident, this.met, through)) this.meet(event);
    this.met = Math.max(this.met, through);
  }

  private awake(wake: Omit<Wake, 'state'>, state: object | undefined) {
    this.land.clock.now = wake.at;
    this.scope = this.land.scope();
    this.learned = 0;
    this.learn(wake.through);
    const woken = awaken(this.land.history, { ...wake, after: state ? wake.after : 0, state }, () => {});
    woken.mind.routeScope = this.scope;
    let relived = 0;
    for (const event of woken.relive()) {
      woken.mind.observe(event);
      relived++;
    }
    woken.mind.awake = true;
    const reach = (woken.terrain && reachOver(woken.terrain)) as Measuring | undefined;
    if (reach) {
      const steps = reach.steps;
      reach.steps = (from, to) => {
        const before = [reach.here, reach.previous];
        const found = steps(from, to);
        if (reach.here && !before.includes(reach.here))
          this.origins.set(reach.here, { x: from.x, y: from.y, z: from.z });
        return found;
      };
      woken.mind.steps = reach.steps;
    }
    this.measuring = reach;
    ({ mind: this.mind, places: this.places, terrain: this.terrain } = woken);
    return relived;
  }

  // A later waking may restore the checkpoint this one saved once it had re-lived (a stop that
  // saved none after it): the mind as it stands now. Any earlier one cannot be carried to.
  private follow(wake: Omit<Wake, 'state'>) {
    this.carried.clear();
    this.pending.clear();
    for (const w of this.wakes) if (w.id > wake.id && w.after >= wake.through) this.pending.add(w.after);
    this.keep(wake.through);
  }

  private wakeUp(wake: Wake, first: boolean) {
    const started = performance.now();
    if (!first) {
      this.meetThrough(wake.after);
      this.keep(wake.after);
    }
    const ours = this.carried.get(wake.after);
    const mode = wake.state ? 'checkpoint' : first ? 'birth' : ours ? 'carried' : 'birth';
    const relived = this.awake(wake, wake.state ?? (mode === 'carried' ? ours : undefined));
    const { state: _, ...bare } = wake;
    this.woke({
      wake: wake.id,
      at: wake.at,
      through: wake.through,
      after: wake.after,
      mode,
      relived,
      differs: wake.state && ours ? differences(ours, wake.state) : undefined,
      ms: Math.round(performance.now() - started)
    });
    this.met = Math.max(this.met, wake.through);
    this.current = bare;
    this.follow(bare);
  }

  // Up to where a decision began weighing, waking as the live mind woke on the way.
  reach(row: Row): Trace | string {
    const trace = (JSON.parse(row.data) as Recorded).trace;
    if (!trace) return 'not traced';
    const wake = this.land.history.wakeBefore(this.resident, trace.from + 1);
    if (!wake) return 'no waking recorded before it';
    if (wake.id !== this.current?.id) {
      for (const w of this.wakes) if (this.current && w.id > this.current.id && w.id < wake.id) this.wakeUp(w, false);
      this.wakeUp(wake, !this.current);
    }
    this.meetThrough(trace.from);
    this.learn(trace.from);
    return trace;
  }

  // A decision weighed, from where the chain stands at its start, with a scenario changed or none.
  weigh(row: Row, trace: Trace, scenario: Scenario = {}, name = ''): Weighing {
    const mind = this.mind;
    if (!mind) throw new Error('The chain has not woken.');
    const started = performance.now();
    const recorded = JSON.parse(row.data) as Recorded;
    const encounter = new TapedEncounter(trace.tape);
    const answers: Record<string, boolean> = {};
    for (const [question, answer] of trace.tape) if (typeof answer === 'boolean') answers[question] = answer;
    const ask = (question: string, own: () => boolean) => {
      const answer = scenario.answers?.[question] ?? (question in answers ? own() : false);
      answers[question] = answer;
      return answer;
    };
    const tape = encounter as unknown as Encounter;
    const allows = encounter.allows.bind(encounter);
    const allowsKind = encounter.allowsKind.bind(encounter);
    tape.allows = (serial: number) => ask(`allows ${serial}`, () => allows(serial));
    tape.allowsKind = (kind: string) => ask(`allowsKind ${kind}`, () => allowsKind(kind));
    mind.encounter = tape;
    this.land.clock.now = trace.now;
    const restore = applyScenario(mind, scenario, this.land.clock.now);
    const seen: Watch = watch(mind, scenario);
    try {
      const stood = mind.position;
      const work = deliberate(mind, this.terrain, new Set(), placesOf(this.land.history, mind), trace.active);
      let steps = 0;
      let valued: Valued[] | undefined;
      for (const [upTo, mark, at] of trace.slices) {
        while (steps < upTo && !valued) {
          const next = work.next();
          steps++;
          if (next.done) valued = next.value;
        }
        this.meetThrough(mark);
        this.land.clock.now = at;
      }
      while (!valued) {
        const next = work.next();
        if (next.done) valued = next.value;
      }
      const blocked = (id: string) =>
        scenario.blocked?.[id] ?? recorded.options?.find((o) => o.id === id)?.blocked ?? false;
      return {
        id: row.id,
        resident: this.resident,
        name,
        kind: row.kind as Weighing['kind'],
        at: row.at,
        trigger: recorded.trigger || 'start',
        ...(row.kind === 'reconsidered' && recorded.id ? { plan: recorded.id } : {}),
        tuning: { ...tuning },
        ...inputsOf(mind, stood, seen, answers),
        options: valued.map((o) => ({
          id: o.id,
          key: o.key,
          learn: o.learn ?? o.key,
          value: o.value,
          seconds: o.seconds,
          rate: o.rate,
          urgent: !!o.urgent,
          blocked: blocked(o.id)
        })),
        chose: choose(row.kind, recorded, valued, mind, blocked),
        digest: digest(valued) ?? '',
        ms: Math.round(performance.now() - started)
      };
    } finally {
      seen.stop();
      restore();
    }
  }
}

export const liveOf = (row: Row): LiveDecision => {
  const d = JSON.parse(row.data) as Recorded;
  return {
    chose:
      row.kind === 'considered'
        ? `${d.doing} (${d.id ?? 'none'})`
        : d.kept
          ? `kept ${d.id}`
          : `switched to ${d.alternative?.id}`,
    digest: d.trace?.digest,
    options: d.options ?? (d.alternative ? [{ ...d.alternative, value: 0, seconds: 0 }] : [])
  };
};

// The AI's judgements as a scenario sets them, for as long as `run` takes.
export function tuned<T>(values: Record<string, number> | undefined, run: () => T): T {
  tune(values ?? {});
  try {
    return run();
  } finally {
    tune({});
  }
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
  const found: string[] = [];
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    found.push(
      ...differences((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], `${path}.${key}`)
    );
    if (found.length > 40) break;
  }
  return found;
}
