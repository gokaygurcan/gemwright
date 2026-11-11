import { add, type Outcome } from './beliefs';
import type { HistoryEvent } from './history';
import { type Facts, facts } from './knowledge';

type Data = Record<string, unknown>;
type Property = { cliloc: number; arguments: string };

// What it knows of the things about it: what each looks like, which are creatures, which are its
// own and how many, what it holds in hand, what holds what, what is fixed in place, its bank box,
// corpses by the death that left them. What it gains and loses of its own goes to the attempt under
// way (`outcome`); what opening one of its own containers shows was its own already.
export class Things {
  snapshot() {
    return { ...this };
  }

  restore(state: ReturnType<Things['snapshot']>) {
    Object.assign(this, state);
  }

  readonly names = new Map<number, string>();
  readonly mobiles = new Set<number>();
  readonly owned = new Map<number, { name: string; amount: number }>();
  readonly held = new Set<number>();
  readonly healths = new Map<number, number>();
  // What each thing's hover said: its weight, and what makes a piece good.
  readonly described = new Map<number, Facts>();
  private readonly parents = new Map<number, number>();
  private readonly fixed = new Set<number>();
  private bank = -1;
  private readonly corpses = new Map<number, string>();
  diedAt: HistoryEvent['where'];
  rest?: { name: string; amount: number };
  self = -1;
  // Its own mount, standing as a creature while it is off it: the one that appeared where it stood
  // as the mount it rode left it.
  mount?: number;
  private appeared?: { serial: number; x: number; y: number; at: number };

  // It sees afresh: what was in view and in hand last time is perceived again from now.
  wake(self: number) {
    const banked = new Set(
      this.self === self ? [...this.parents.keys(), ...this.owned.keys()].filter((serial) => this.inBank(serial)) : []
    );
    for (const seen of [this.names, this.mobiles, this.healths, this.owned, this.held, this.parents, this.fixed])
      for (const serial of seen.keys()) if (!banked.has(serial)) seen.delete(serial);
    this.rest = undefined;
    this.self = self;
  }

  observe(event: HistoryEvent, outcome: Outcome | undefined, attempt: { object?: number; key: string } | undefined) {
    const data = event.data as Data;
    switch (event.kind) {
      case 'seen':
      case 'revealed':
      case 'gained':
      case 'changed': {
        const serial = data.serial as number;
        if (Array.isArray(data.is) || event.kind !== 'changed') this.names.set(serial, this.nameOf(data));
        if (data.kind === 'mobile') this.mobiles.add(serial);
        if (Array.isArray(data.properties)) this.described.set(serial, facts(data.properties as Property[]));
        if (event.kind === 'seen' && data.kind === 'mobile' && typeof data.x === 'number')
          this.appeared = { serial, x: data.x, y: data.y as number, at: event.at };
        if (typeof data.hits === 'number' && typeof data.maxHits === 'number' && data.maxHits > 0)
          this.healths.set(serial, data.hits / data.maxHits);
        // The corpse that appears where it died is its own.
        const died = this.diedAt;
        if (event.kind === 'seen' && died && (data.is as string[] | undefined)?.includes('Corpse')) {
          if (Math.max(Math.abs((data.x as number) - died.x), Math.abs((data.y as number) - died.y)) <= 1) {
            this.corpses.set(serial, 'my Corpse');
            this.diedAt = undefined;
          }
        }
        // The server marks which items a player may move (ServUO Item.GetPacketFlags, 0x20); a
        // mobile's flags mean other things.
        if (typeof data.flags === 'number' && !this.mobiles.has(serial)) {
          if (data.flags & 0x20) this.fixed.delete(serial);
          else this.fixed.add(serial);
        }
        if (typeof data.parent === 'number') this.parents.set(serial, data.parent);
        else if (typeof data.x === 'number') this.parents.delete(serial);
        const name = this.names.get(serial) ?? `g${data.graphic}`;
        const mine = this.owned.get(serial);
        // Seen closer (its hover), one of its own things may turn out to be something else.
        if (mine && event.kind === 'changed' && Array.isArray(data.is)) mine.name = name;
        const amount = (data.amount as number | undefined) ?? (event.kind === 'changed' ? undefined : 1);
        if (data.layer === 29 && data.parent === this.self) this.bank = serial;
        // Something it held in hand lands: back among its things it is placed, elsewhere it is lost.
        // What its bank box holds was always its own: opening the box only shows it.
        const split = event.kind === 'gained' && this.rest?.name === name && this.rest.amount === amount;
        if (split) this.rest = undefined;
        const placed = this.held.delete(serial) || split;
        if (event.kind === 'gained' || event.kind === 'revealed') {
          this.owned.set(serial, { name, amount: amount ?? 1 });
          // What opening one of its own containers shows was in it already.
          const shown = attempt?.object === data.parent && attempt?.key.startsWith('double-click my ');
          // Mounting brings back the mount it rode, not something new.
          const ridden = data.layer === 25 && data.parent === this.self;
          if (outcome && event.kind === 'gained' && !placed && !shown && !ridden && !this.inBank(serial))
            add(outcome.gained, name, amount ?? 1);
        } else if (placed && mine) {
          this.owned.delete(serial);
          if (outcome) add(outcome.lost, mine.name, mine.amount);
        } else if (mine && amount !== undefined && amount !== mine.amount) {
          // What it held, dropped back onto a stack of its kind, is the stack's again.
          const back = [...this.held].find((held) => {
            const item = this.owned.get(held);
            return item?.name === mine.name && item.amount === amount - mine.amount;
          });
          if (back !== undefined) {
            this.held.delete(back);
            this.owned.delete(back);
          } else if (outcome)
            add(amount > mine.amount ? outcome.gained : outcome.lost, mine.name, Math.abs(amount - mine.amount));
          mine.amount = amount;
        }
        break;
      }
      case 'lost': {
        // Picked up, it is in hand: still its own until it lands somewhere.
        if (this.held.has(data.serial as number)) break;
        // Off its mount: what it rode is now the creature standing where it is, still its own.
        if (data.layer === 25 && data.parent === this.self) {
          this.owned.delete(data.serial as number);
          const left = this.appeared;
          if (left && event.where && left.x === event.where.x && left.y === event.where.y && event.at - left.at < 1000)
            this.mount = left.serial;
          break;
        }
        const mine = this.owned.get(data.serial as number);
        this.owned.delete(data.serial as number);
        if (mine && outcome) add(outcome.lost, mine.name, mine.amount);
        break;
      }
      case 'gone':
        if (!this.owned.has(data.serial as number)) {
          this.names.delete(data.serial as number);
          this.described.delete(data.serial as number);
        }
        this.parents.delete(data.serial as number);
        this.corpses.delete(data.serial as number);
        this.fixed.delete(data.serial as number);
        this.mobiles.delete(data.serial as number);
        this.healths.delete(data.serial as number);
        break;
      case 'death': {
        const dead = this.names.get(data.serial as number);
        if (dead) this.corpses.set(data.corpse as number, `Corpse of ${dead}`);
        break;
      }
    }
  }

  // What one of a kind of thing weighs, from the piles of it it has hovered.
  unitWeight(name: string) {
    for (const [serial, item] of this.owned) {
      const weight = this.described.get(serial)?.weight;
      if (item.name === name && weight !== undefined && item.amount) return weight / item.amount;
    }
    return undefined;
  }

  // Lifting one of its own: in hand, and part of a stack leaves the rest behind as a new item
  // (ServUO LiftItemDupe).
  lift(serial: number, amount: number | undefined) {
    const lifted = this.owned.get(serial);
    if (!lifted) return;
    this.held.add(serial);
    if (amount !== undefined && amount < lifted.amount) {
      this.rest = { name: lifted.name, amount: lifted.amount - amount };
      lifted.amount = amount;
    }
  }

  private nameOf(data: Data) {
    const is = data.is as string[] | undefined;
    return is?.length ? is.join('/') : `g${data.graphic}`;
  }

  thing(serial: unknown) {
    if (typeof serial !== 'number' || serial === 0 || serial === 0xffffffff) return undefined;
    if (serial === this.self) return 'self';
    if (this.corpses.get(serial) === 'my Corpse') return 'my Corpse';
    if (serial === this.mount) return `my ${this.names.get(serial) ?? 'Mount'}`;
    const mine = this.owned.get(serial);
    return mine ? `my ${mine.name}` : this.placed(serial);
  }

  inBank(serial: number) {
    for (let at: number | undefined = serial, hops = 0; at !== undefined && hops < 16; hops++) {
      if (at === this.bank) return true;
      at = this.parents.get(at);
    }
    return false;
  }

  // What it calls a thing: a corpse by the death it saw leave it, anything else by what it looks like.
  private called(serial: number) {
    return this.corpses.get(serial) ?? this.names.get(serial) ?? 'unknown';
  }

  // A thing not its own, by where it is: on the ground, or in or on whatever holds it.
  private placed(serial: number) {
    const name = this.called(serial);
    let root = this.parents.get(serial);
    for (let hops = 0; root !== undefined && this.parents.has(root) && hops < 16; hops++) root = this.parents.get(root);
    if (root === undefined) return this.fixed.has(serial) ? `${name} fixed` : name;
    const holder = root === this.self ? 'me' : this.called(root);
    return `${name} ${this.mobiles.has(root) || root === this.self ? 'on' : 'in'} ${holder}`;
  }
}
