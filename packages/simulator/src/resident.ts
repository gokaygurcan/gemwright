import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';

import { History, type HistoryEvent } from '../../ai/src/history';
import type { Mind } from '../../ai/src/mind';
import { deliberate, type Valued } from '../../ai/src/planning';
import { reachOver } from '../../ai/src/reach';
import { placesOf } from '../../ai/src/shadow';
import { rebuild } from '../../ai/src/simulate';
import { defaults, type Tuning, tune } from '../../ai/src/tuning';
import { listen, plain, type Read } from './context';
import { children, set } from './state';

type Snapshot = ReturnType<Mind['snapshot']>;
type Event = { kind: string; data: object; where?: HistoryEvent['where'] };

// One resident as it stands at the end of its history, rebuilt the way the AI rebuilds it on waking
// (ai simulate.ts), then lived on here by hand. Anything it decides with can be changed: its
// state, the answers it gets while weighing (pins), the AI's judgements (tuning), and what came of
// what it did. Every change is a step that can be taken back.
export class Resident {
  private readonly clock = { now: 0 };
  private readonly mind: Mind;
  private readonly terrain: ReturnType<typeof rebuild>['terrain'];
  private readonly meet: (event: HistoryEvent) => void;
  private weighed: Valued[] = [];
  private reads = new Map<string, Read>();
  private pins = new Map<string, unknown>();
  private tuning: Partial<Tuning> = {};
  private log: { at: number; what: string; detail?: unknown }[] = [];
  private readonly steps: {
    label: string;
    mind: Buffer;
    now: number;
    pins: [string, unknown][];
    tuning: Partial<Tuning>;
    log: number;
  }[] = [];

  constructor(
    private readonly history: History,
    readonly name: string
  ) {
    const wake = history.wakeBefore(name, Number.MAX_SAFE_INTEGER);
    if (!wake) throw new Error(`${name} has never woken.`);
    const { mind, terrain, meet } = this.timed(() => rebuild(history, wake, latest(history.path, name), this.clock));
    this.mind = mind;
    this.terrain = terrain;
    this.meet = meet;
    const reach = terrain && reachOver(terrain);
    if (reach) mind.steps = reach.steps;
  }

  // Its mind runs on this resident's clock and judgements, not the wall's or the process's.
  private timed<T>(work: () => T): T {
    const real = Date.now;
    Date.now = () => this.clock.now;
    tune(this.tuning);
    try {
      return work();
    } finally {
      Date.now = real;
      tune({});
    }
  }

  // Kept before every change, so it can be taken back.
  private keep(label: string) {
    this.steps.push({
      label,
      mind: serialize(this.mind.snapshot()),
      now: this.clock.now,
      pins: [...this.pins],
      tuning: { ...this.tuning },
      log: this.log.length
    });
    this.log.push({ at: this.clock.now, what: label });
  }

  undo() {
    const last = this.steps.pop();
    if (!last) throw new Error('Nothing to take back.');
    this.mind.restore(deserialize(last.mind) as Snapshot);
    this.mind.revision++;
    this.clock.now = last.now;
    this.pins = new Map(last.pins);
    this.tuning = last.tuning;
    this.log = this.log.slice(0, last.log);
  }

  // It weighs what it could do, and every question it asked meanwhile is kept with its answer.
  view() {
    return this.timed(() => {
      this.reads = new Map();
      const stop = listen(
        [
          ['', this.mind],
          ['self.', this.mind.self]
        ],
        this.pins,
        this.reads
      );
      try {
        const work = deliberate(this.mind, this.terrain, new Set(), placesOf(this.history, this.mind));
        let next = work.next();
        while (!next.done) next = work.next();
        this.weighed = next.value;
      } finally {
        stop();
      }
      return {
        now: this.clock.now,
        steps: this.steps.map((s) => s.label),
        log: this.log,
        tuning: { defaults, set: this.tuning },
        reads: [...this.reads.values()].map((r) => ({ ...r, value: plain(r.value) })),
        options: this.weighed.map(({ source: _source, steps, ...o }) => ({
          ...(plain(o) as object),
          steps: steps.map((s) => s.verb),
          chance: this.mind.chance(o.id)
        }))
      };
    });
  }

  // The mind's whole state under a path, one level at a time.
  state(path: string[]) {
    return children(this.mind.snapshot(), path);
  }

  edit(path: string[], value: unknown) {
    this.keep(`set ${path.join('.')} = ${JSON.stringify(value)}`);
    const snapshot = this.mind.snapshot();
    set(snapshot, path, value);
    this.mind.restore(snapshot);
    this.mind.revision++;
  }

  pin(key: string, value: unknown) {
    this.keep(value === undefined ? `unpin ${key}` : `pin ${key} = ${JSON.stringify(value)}`);
    if (value === undefined) this.pins.delete(key);
    else this.pins.set(key, value);
  }

  tune(values: Partial<Tuning>) {
    this.keep(`tune ${JSON.stringify(values)}`);
    this.tuning = { ...this.tuning, ...values };
  }

  // It does an option: the time it takes passes, it succeeds or fails, and anything else that came
  // of it is told to its mind as events.
  act(id: string, succeeded: boolean, seconds: number | undefined, events: Event[]) {
    const option = this.weighed.find((o) => o.id === id);
    if (!option) throw new Error(`No option ${id} was weighed.`);
    this.keep(`do ${option.key}: ${succeeded ? 'succeeded' : 'failed'}`);
    this.timed(() => {
      this.clock.now += Math.round((seconds ?? option.seconds) * 1000);
      this.mind.complete(id, succeeded);
      for (const event of events) this.perceive(event);
    });
  }

  // Something it perceives: a 'self' event moves it (`where`) or changes its body, 'skill' a skill.
  tell(event: Event) {
    this.keep(`tell ${event.kind}`);
    this.timed(() => this.perceive(event));
  }

  private perceive({ kind, data, where }: Event) {
    this.meet({
      resident: this.name,
      at: this.clock.now,
      kind,
      data,
      where: where ?? this.mind.position,
      via: 'perceived'
    });
    this.log.push({ at: this.clock.now, what: `perceived ${kind}`, detail: data });
  }

  wait(seconds: number) {
    this.keep(`wait ${seconds}s`);
    this.clock.now += seconds * 1000;
  }
}

const latest = (path: string, resident: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ id: number }, [string]>('SELECT MAX(id) AS id FROM events WHERE resident = ?').get(resident)
      ?.id as number;
  } finally {
    db.close();
  }
};

export const openHistory = (land: string) => new History(join(land, 'history.sqlite'), true);

// Every resident that has woken.
export function residents(land: string) {
  const db = new Database(join(land, 'history.sqlite'), { readonly: true });
  try {
    return db.query<{ resident: string }, []>('SELECT DISTINCT resident FROM wakes ORDER BY resident').all();
  } finally {
    db.close();
  }
}
