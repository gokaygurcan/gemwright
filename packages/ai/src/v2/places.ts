import type { HistoryEvent } from './history';

interface Fact {
  name: string;
  x: number;
  y: number;
  map: number | null;
  since: number;
  last: number;
  watching: boolean;
}
type Data = Record<string, unknown>;
type Kinds = Map<string, { watched: number; endings: number }>;
// The client's view range: how far the resident sees around itself.
const sight = 18;

// Where things are and how long each kind stays. A fact is a thing at a tile. It ends when the thing
// moves off that tile or vanishes while the tile is in sight; when the resident walks away the fact
// is kept and only the time it was watched counts. A kind's lifetime is its watched time over its
// witnessed endings (one ending assumed before any is seen), so belief in an old sighting fades as
// fast as that kind of thing really moves on: buildings stay, people wander.
export class Places {
  private readonly facts = new Map<number, Fact>();
  private readonly kinds: Kinds = new Map();
  // What this session has learned and not yet written: written once as it sleeps.
  private readonly fresh: Kinds = new Map();
  private readonly names = new Map<number, string>();
  private here?: { x: number; y: number };

  constructor(
    private readonly resident: string,
    private readonly record: (event: HistoryEvent) => void,
    past: { lifetimes: object[]; left: object[] }
  ) {
    for (const learned of past.lifetimes as Record<string, { watched: number; endings: number }>[])
      for (const [name, { watched, endings }] of Object.entries(learned))
        this.learn(this.kinds, name, watched, endings);
    for (const { serial, ended, ...fact } of past.left as (Fact & { serial: number; ended: boolean })[])
      if (ended) this.facts.delete(serial);
      else this.facts.set(serial, { ...fact, since: fact.last, watching: false });
    // What it no longer believes from all it ever walked away from is not carried into this life.
    for (const _ of this.remembered());
  }

  observe(event: HistoryEvent) {
    const data = event.data as Data;
    if (event.where) this.here = event.where;
    const serial = data.serial as number;
    switch (event.kind) {
      case 'seen':
      case 'changed': {
        const is = data.is as string[] | undefined;
        if (is) this.names.set(serial, is.length ? is.join('/') : `g${data.graphic}`);
        const name = this.names.get(serial);
        const fact = this.facts.get(serial);
        const x = (data.x as number | undefined) ?? fact?.x;
        const y = (data.y as number | undefined) ?? fact?.y;
        if (!name || x === undefined || y === undefined || data.parent !== undefined) break;
        const moved = fact?.watching && (fact.x !== x || fact.y !== y);
        if (fact?.watching && moved) this.end(fact, event.at, true);
        this.facts.set(serial, {
          name,
          x,
          y,
          map: event.where?.map ?? fact?.map ?? null,
          since: fact?.watching && !moved ? fact.since : event.at,
          last: event.at,
          watching: true
        });
        break;
      }
      case 'gone': {
        const fact = this.facts.get(serial);
        this.names.delete(serial);
        if (!fact?.watching || !this.here) break;
        const ended = Math.max(Math.abs(fact.x - this.here.x), Math.abs(fact.y - this.here.y)) < sight;
        this.end(fact, event.at, ended);
        if (ended) this.facts.delete(serial);
        else this.facts.set(serial, { ...fact, last: event.at, watching: false });
        this.write(event.at, 'left', { serial, ...fact, last: event.at, ended });
        break;
      }
      case 'asleep':
        for (const [serial, fact] of this.facts)
          if (fact.watching) {
            this.end(fact, event.at, false);
            this.facts.set(serial, { ...fact, last: event.at, watching: false });
            this.write(event.at, 'left', { serial, ...fact, last: event.at, ended: false });
          }
        if (this.fresh.size) this.write(event.at, 'lifetimes', Object.fromEntries(this.fresh));
        this.fresh.clear();
        break;
    }
  }

  private end(fact: Fact, at: number, ended: boolean) {
    const seconds = Math.max(0, (at - fact.since) / 1000);
    this.learn(this.kinds, fact.name, seconds, ended ? 1 : 0);
    this.learn(this.fresh, fact.name, seconds, ended ? 1 : 0);
  }

  private learn(into: Kinds, name: string, watched: number, endings: number) {
    const kind = into.get(name) ?? { watched: 0, endings: 0 };
    kind.watched = Math.round((kind.watched + watched) * 1000) / 1000;
    kind.endings += endings;
    into.set(name, kind);
  }

  private write(at: number, kind: string, data: object) {
    this.record({ resident: this.resident, at, kind, data });
  }

  // What it saw and no longer sees, still believed where it was: each thing out of sight for less
  // than its kind is seen to stay. One out of sight for longer is no longer believed, and forgotten.
  *remembered(now = Date.now()) {
    for (const [serial, fact] of this.facts) {
      if (fact.watching) continue;
      if ((now - fact.last) / 1000 < this.lifetime(fact.name))
        yield { serial, name: fact.name, x: fact.x, y: fact.y, last: fact.last };
      else this.facts.delete(serial);
    }
  }

  // How long a kind of thing is seen to stay: its watched time over its witnessed endings.
  private lifetime(name: string) {
    const kind = this.kinds.get(name);
    return kind ? kind.watched / (kind.endings + 1) : 0;
  }

  // Where it believes things of a type are, and how sure it is that each is still there: certain
  // while in view, then fading by how long that kind of thing has been seen to stay.
  believed(type: string, now = Date.now()) {
    return [...this.facts.values()]
      .filter((fact) => fact.name.split('/').includes(type))
      .map((fact) => {
        const lifetime = this.lifetime(fact.name);
        const confidence = fact.watching ? 1 : lifetime ? Math.exp(-(now - fact.last) / 1000 / lifetime) : 0;
        return { name: fact.name, x: fact.x, y: fact.y, map: fact.map, confidence, lifetime };
      });
  }
}
