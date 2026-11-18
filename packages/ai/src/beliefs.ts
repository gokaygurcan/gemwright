import { tuning } from './tuning';

export interface Outcome {
  seconds: number;
  health: number;
  skill: number;
  // Which skills moved, and by how much.
  skills: Record<string, number>;
  gained: Record<string, number>;
  lost: Record<string, number>;
  heard: Record<string, number>;
  died: number;
  killed: number;
  // How far it ends up from where it began, and whether it is on another map.
  moved: number;
  crossed: number;
}
// The situation an attempt began in, relative to the resident: how healthy it was, how much it
// carried, how many creatures were about, how hurt its opponent was. A missing part is unknown.
export type Context = Record<string, number>;

export const empty = (): Outcome => ({
  seconds: 0,
  health: 0,
  skill: 0,
  skills: {},
  gained: {},
  lost: {},
  heard: {},
  died: 0,
  killed: 0,
  moved: 0,
  crossed: 0
});
export const add = (into: Record<string, number>, key: string, amount: number) => {
  into[key] = (into[key] ?? 0) + amount;
};
export const round = (n: number) => Math.round(n * 1000) / 1000;
export const scale = (o: Outcome, by: number): Outcome => {
  const each = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v * by)]));
  return {
    seconds: round(o.seconds * by),
    health: round(o.health * by),
    skill: round(o.skill * by),
    skills: each(o.skills ?? {}),
    gained: each(o.gained),
    lost: each(o.lost),
    heard: each(o.heard),
    died: round(o.died * by),
    killed: round(o.killed * by),
    moved: round(o.moved * by),
    crossed: round(o.crossed * by)
  };
};
export const fold = (into: Outcome, o: Outcome, by = 1) => {
  into.seconds += o.seconds * by;
  into.health += o.health * by;
  into.skill += o.skill * by;
  into.died += o.died * by;
  into.killed += o.killed * by;
  into.moved += o.moved * by;
  into.crossed += o.crossed * by;
  for (const part of ['skills', 'gained', 'lost', 'heard'] as const)
    for (const [k, v] of Object.entries(o[part] ?? {})) add(into[part], k, v * by);
};
export const difference = (observed: Outcome, expected: Outcome) => {
  const keyed = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(
      [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .map((k) => [k, round((a[k] ?? 0) - (b[k] ?? 0))] as const)
        .filter(([, v]) => v !== 0)
    );
  return {
    seconds: round(observed.seconds - expected.seconds),
    health: round(observed.health - expected.health),
    skill: round(observed.skill - expected.skill),
    gained: keyed(observed.gained, expected.gained),
    lost: keyed(observed.lost, expected.lost),
    died: round(observed.died - expected.died),
    killed: round(observed.killed - expected.killed),
    moved: round(observed.moved - expected.moved),
    crossed: round(observed.crossed - expected.crossed)
  };
};

// What each kind of attempt has brought, and in what situation. An expectation weighs every past
// attempt by how alike its situation was to now: each part of the situation measured against how
// much it has varied across those attempts, and counted only as much as it has earned. A part earns
// its weight by making predictions better: after each attempt, how much closer (or further) would
// counting it have predicted the outcome's worth than leaving it out? Every part starts out counting
// for nothing, so at first all past attempts count alike. Foresight from the wiki counts as one more attempt.
export class Beliefs {
  snapshot() {
    return { ...this };
  }

  restore(state: ReturnType<Beliefs['snapshot']>) {
    Object.assign(this, state);
  }

  private readonly travel = new Map<string, { steps: number; seconds: number; stamina: number }>();

  moved(key: string, steps: number, seconds: number, stamina: number) {
    const past = this.travel.get(key) ?? { steps: 0, seconds: 0, stamina: 0 };
    this.travel.set(key, {
      steps: past.steps + steps,
      seconds: past.seconds + seconds,
      stamina: past.stamina + stamina
    });
  }

  movement(key: string) {
    return this.travel.get(key);
  }

  private readonly depleted = new Map<string, { at: number; until: number }>();

  exhaust(bank: { x: number; y: number; width: number; height: number }, until: number, at = Date.now()) {
    const x = Math.floor(bank.x / bank.width) * bank.width;
    const y = Math.floor(bank.y / bank.height) * bank.height;
    for (let dx = 0; dx < bank.width; dx++)
      for (let dy = 0; dy < bank.height; dy++) this.depleted.set(`${x + dx},${y + dy}`, { at, until });
  }

  availability(key: string, now = Date.now()) {
    const depleted = this.depleted.get(key);
    if (!depleted || depleted.until <= now) return 1;
    return Math.max(0, (now - depleted.at) / (depleted.until - depleted.at));
  }

  private readonly executions = new Map<string, { tries: number; succeeded: number }>();

  executed(id: string, succeeded: boolean) {
    const past = this.executions.get(id) ?? { tries: 0, succeeded: 0 };
    past.tries++;
    if (succeeded) past.succeeded++;
    this.executions.set(id, past);
  }

  chance(id: string) {
    const past = this.executions.get(id);
    return past ? (past.succeeded + tuning.chancePrior) / (past.tries + tuning.chancePrior) : 1;
  }
  private readonly pasts = new Map<string, { context: Context; outcome: Outcome }[]>();
  private readonly totals = new Map<string, Outcome>();
  private readonly moments = new Map<string, Map<string, { n: number; mean: number; m2: number }>>();
  private readonly earned = new Map<string, { better: number; moved: number }>();

  // `worth`: how much an outcome means to the resident, the measure a prediction is judged by.
  learn(key: string, context: Context, outcome: Outcome, worth: (o: Outcome) => number) {
    const pasts = this.pasts.get(key) ?? [];
    for (const part of Object.keys(context)) {
      const miss = (weight: number) => {
        const expected = this.expect(key, context, undefined, { [part]: weight }).outcome;
        return expected ? Math.abs(worth(expected) - worth(outcome)) : 0;
      };
      const counted = miss(1);
      const left = miss(0);
      const record = this.earned.get(part) ?? { better: 0, moved: 0 };
      record.better += left - counted;
      record.moved += Math.abs(left - counted);
      this.earned.set(part, record);
    }
    const total = this.totals.get(key) ?? empty();
    fold(total, outcome);
    this.totals.set(key, total);
    const moments = this.moments.get(key) ?? new Map();
    for (const [part, value] of Object.entries(context)) {
      const moment = moments.get(part) ?? { n: 0, mean: 0, m2: 0 };
      moment.n++;
      const delta = value - moment.mean;
      moment.mean += delta / moment.n;
      moment.m2 += delta * (value - moment.mean);
      moments.set(part, moment);
    }
    this.moments.set(key, moments);
    pasts.push({ context, outcome });
    fold(this.lived, outcome);
    this.attempts++;
    this.pasts.set(key, pasts);
  }

  // How much a part of the situation counts: how much it has made predictions better, of all it has
  // changed them. A part that helps by chance as often as it hurts nets out to nothing.
  weight(part: string) {
    const record = this.earned.get(part);
    return record?.moved ? Math.max(0, record.better / record.moved) : 0;
  }

  // The skill an attempt trains: the one its past attempts moved most.
  trains(key: string) {
    return Object.entries(this.totals.get(key)?.skills ?? {})
      .filter(([, by]) => by > 0)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  keys() {
    return this.pasts.keys();
  }

  // Whether it has tried this key at all: what it could expect from it, if anything.
  has(key: string) {
    return this.pasts.has(key);
  }

  // All it has lived, whatever the attempt, added up, and over how many attempts.
  readonly lived = empty();
  attempts = 0;

  expect(key: string, context: Context, foresight?: Partial<Outcome>, trying: Record<string, number> = {}) {
    const pasts = this.pasts.get(key) ?? [];
    const spread = new Map<string, { sd: number; weight: number }>();
    for (const part of Object.keys(context)) {
      const moment = this.moments.get(key)?.get(part);
      const weight = trying[part] ?? this.weight(part);
      if (moment && moment.m2 > 0 && weight > 0) spread.set(part, { sd: Math.sqrt(moment.m2 / moment.n), weight });
    }
    const total = empty();
    let weight = 0;
    if (!spread.size) {
      const accumulated = this.totals.get(key);
      if (accumulated) fold(total, accumulated);
      weight = pasts.length;
    } else
      for (const past of pasts) {
        let distance = 0;
        for (const [part, { sd, weight }] of spread) {
          const then = past.context[part];
          const now = context[part];
          if (then !== undefined && now !== undefined) distance += weight * ((now - then) / sd) ** 2;
        }
        const alike = Math.exp(-distance / 2);
        fold(total, past.outcome, alike);
        weight += alike;
      }
    if (foresight) {
      fold(total, { ...empty(), ...foresight });
      weight++;
    }
    return {
      n: pasts.length,
      alike: round(weight - (foresight ? 1 : 0)),
      foreseen: !!foresight,
      outcome: weight ? scale(total, 1 / weight) : undefined
    };
  }
}
