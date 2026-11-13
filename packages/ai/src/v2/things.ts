import { isDeathRobe } from '@gemwright/common/game/items';

import { add, type Outcome } from './beliefs';
import type { HistoryEvent } from './history';
import { type Facts, facts } from './knowledge';

type Data = Record<string, unknown>;
export interface Sight {
  serial: number;
  kind: 'mobile' | 'item';
  name?: string;
  // A character's own name, as distinct from what kind of thing it is.
  label?: string;
  graphic?: number;
  hue?: number;
  parent?: number;
  layer?: number;
  amount?: number;
  position?: { x: number; y: number; z: number };
  // Whether its hover has been read.
  described: boolean;
  fixed: boolean;
  movable: boolean;
  notoriety?: number;
}
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

  readonly graphics = new Map<number, number>();
  readonly names = new Map<number, string>();
  // What a mobile calls itself (its character name), as distinct from what kind of thing it is: a
  // person is a Person, and Marcy is Marcy.
  readonly labels = new Map<number, string>();
  readonly mobiles = new Set<number>();
  readonly owned = new Map<number, { name: string; amount: number }>();
  readonly held = new Set<number>();
  readonly healths = new Map<number, number>();
  // What each thing's hover said: its weight, and what makes a piece good.
  readonly described = new Map<number, Facts>();
  private readonly parents = new Map<number, number>();
  private readonly notorieties = new Map<number, number>();
  private readonly movable = new Set<number>();
  private readonly fixed = new Set<number>();
  // Where each worn thing is worn (its layer), where each thing lies on the ground, and how many of
  // a thing not its own there are.
  private readonly layers = new Map<number, number>();
  private readonly spots = new Map<number, { x: number; y: number; z: number }>();
  // What is on its screen now: in view, worn, in its pack, or in an open container.
  private readonly present = new Set<number>();
  private readonly counts = new Map<number, number>();
  private readonly hues = new Map<number, number>();
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
    for (const seen of [
      this.names,
      this.graphics,
      this.labels,
      this.mobiles,
      this.healths,
      this.owned,
      this.held,
      this.parents,
      this.fixed,
      this.movable,
      this.notorieties,
      this.layers,
      this.spots,
      this.counts,
      this.hues,
      this.present
    ])
      for (const serial of seen.keys()) if (!banked.has(serial)) seen.delete(serial);
    // A new session's screen starts empty: what the bank holds is remembered, not shown.
    this.present.clear();
    this.rest = undefined;
    this.self = self;
  }

  observe(event: HistoryEvent, outcome: Outcome | undefined, attempt: { object?: number; key: string } | undefined) {
    const data = event.data as Data;
    switch (event.kind) {
      case 'care':
        if (data.action === 'claim' && data.answer === 'claimed' && typeof data.serial === 'number')
          this.mount = data.serial;
        break;
      case 'seen':
      case 'revealed':
      case 'gained':
      case 'changed': {
        const serial = data.serial as number;
        this.present.add(serial);
        if (typeof data.notoriety === 'number') this.notorieties.set(serial, data.notoriety);
        if (typeof data.graphic === 'number') this.graphics.set(serial, data.graphic);
        if (Array.isArray(data.is) || event.kind !== 'changed') this.names.set(serial, this.nameOf(data));
        // A character's name arrives in its own later event, not with the mobile's first sight.
        if (data.kind === 'mobile' || this.mobiles.has(serial)) {
          this.mobiles.add(serial);
          if (typeof data.name === 'string' && data.name) this.labels.set(serial, data.name);
        }
        if (Array.isArray(data.properties)) this.described.set(serial, facts(data.properties as Property[]));
        if (event.kind === 'seen' && data.kind === 'mobile' && typeof data.x === 'number')
          this.appeared = { serial, x: data.x, y: data.y as number, at: event.at };
        if (typeof data.hits === 'number' && typeof data.maxHits === 'number' && data.maxHits > 0)
          this.healths.set(serial, data.hits / data.maxHits);
        // Any corpse seen is a corpse, whoever's; one it saw die is known by that death.
        if (event.kind === 'seen' && (data.is as string[] | undefined)?.includes('Corpse') && !this.corpses.has(serial))
          this.corpses.set(serial, 'Corpse');
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
          if (data.flags & 0x20) {
            this.fixed.delete(serial);
            this.movable.add(serial);
          } else {
            this.fixed.add(serial);
            this.movable.delete(serial);
          }
        }
        if (typeof data.parent === 'number') {
          this.parents.set(serial, data.parent);
          this.spots.delete(serial);
        } else if (typeof data.x === 'number') this.parents.delete(serial);
        const was = this.spots.get(serial);
        if (typeof data.parent !== 'number' && (was || typeof data.x === 'number'))
          this.spots.set(serial, {
            x: (data.x as number | undefined) ?? was?.x ?? 0,
            y: (data.y as number | undefined) ?? was?.y ?? 0,
            z: (data.z as number | undefined) ?? was?.z ?? 0
          });
        if (typeof data.layer === 'number') this.layers.set(serial, data.layer);
        if (typeof data.amount === 'number') this.counts.set(serial, data.amount);
        if (typeof data.hue === 'number') this.hues.set(serial, data.hue);
        const name = this.names.get(serial) ?? `g${data.graphic}`;
        const mine = this.owned.get(serial);
        // Seen closer (its hover), one of its own things may turn out to be something else.
        if (mine && event.kind === 'changed' && Array.isArray(data.is)) mine.name = name;
        const amount = (data.amount as number | undefined) ?? (event.kind === 'changed' ? undefined : 1);
        if (data.layer === 29 && data.parent === this.self) this.bank = serial;
        // Something it held in hand lands: back among its things it is placed, elsewhere it is lost.
        // What its bank box holds was always its own: opening the box only shows it.
        const split =
          (event.kind === 'gained' || event.kind === 'revealed') &&
          this.rest?.name === name &&
          this.rest.amount === amount;
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
        } else if (placed && mine && !this.belongs(serial)) {
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
        this.present.delete(data.serial as number);
        // Picked up, it is in hand: still its own until it lands somewhere.
        if (this.held.has(data.serial as number)) break;
        // Off its mount: what it rode is now the creature standing where it is, still its own.
        if (
          (data.layer ?? this.layers.get(data.serial as number)) === 25 &&
          (data.parent ?? this.parents.get(data.serial as number)) === this.self
        ) {
          this.layers.delete(data.serial as number);
          this.parents.delete(data.serial as number);
          this.owned.delete(data.serial as number);
          const left = this.appeared;
          if (left && event.where && left.x === event.where.x && left.y === event.where.y && event.at - left.at < 1000)
            this.mount = left.serial;
          break;
        }
        const mine = this.owned.get(data.serial as number);
        this.parents.delete(data.serial as number);
        this.layers.delete(data.serial as number);
        this.owned.delete(data.serial as number);
        if (mine && outcome) add(outcome.lost, mine.name, mine.amount);
        break;
      }
      case 'gone':
        this.present.delete(data.serial as number);
        if (!this.owned.has(data.serial as number)) {
          this.names.delete(data.serial as number);
          this.graphics.delete(data.serial as number);
          this.described.delete(data.serial as number);
        }
        this.labels.delete(data.serial as number);
        this.parents.delete(data.serial as number);
        this.layers.delete(data.serial as number);
        this.spots.delete(data.serial as number);
        this.counts.delete(data.serial as number);
        this.hues.delete(data.serial as number);
        this.corpses.delete(data.serial as number);
        this.fixed.delete(data.serial as number);
        this.movable.delete(data.serial as number);
        this.notorieties.delete(data.serial as number);
        this.mobiles.delete(data.serial as number);
        this.healths.delete(data.serial as number);
        break;
      // Reached for and not there: whatever it believed of it was wrong. One in its bank box counts
      // only when it looked in the open box; out of the box's view, its bank's things are not missed.
      case 'missing': {
        const serial = data.serial as number;
        if (!this.owned.has(serial) || (data.where === 'pack' && this.inBank(serial))) break;
        this.owned.delete(serial);
        this.parents.delete(serial);
        this.layers.delete(serial);
        this.held.delete(serial);
        break;
      }
      case 'listed': {
        const contents = new Set(data.contents as number[]);
        for (const [serial, parent] of this.parents)
          if (parent === data.serial && !contents.has(serial)) {
            this.parents.delete(serial);
            this.owned.delete(serial);
          }
        break;
      }
      case 'death': {
        const dead = this.names.get(data.serial as number);
        if (dead) this.corpses.set(data.corpse as number, `Corpse of ${dead}`);
        break;
      }
    }
  }

  // One thing on its screen now, as it shows: what it is, where it is or what holds it.
  sight(serial: number): Sight | undefined {
    if (!this.present.has(serial)) return undefined;
    return {
      serial,
      kind: this.mobiles.has(serial) ? 'mobile' : 'item',
      name: this.names.get(serial),
      label: this.labels.get(serial),
      graphic: this.graphics.get(serial),
      hue: this.hues.get(serial),
      parent: this.parents.get(serial),
      layer: this.layers.get(serial),
      amount: this.owned.get(serial)?.amount ?? this.counts.get(serial),
      position: this.spots.get(serial),
      described: this.described.has(serial),
      notoriety: this.notorieties.get(serial),
      movable: this.movable.has(serial),
      fixed: this.fixed.has(serial)
    };
  }

  // Everything on its screen now.
  *sights() {
    for (const serial of this.present) {
      const sight = this.sight(serial);
      if (sight && serial !== this.self) yield sight;
    }
  }

  // Whether a thing of its own is on its person now: worn or in its pack, not in its bank box.
  carrying(serial: number) {
    return this.owned.has(serial) && this.belongs(serial) && !this.inBank(serial);
  }

  // Its backpack and its bank box, as worn.
  worn(layer: number) {
    for (const [serial, at] of this.layers) if (at === layer && this.parents.get(serial) === this.self) return serial;
    return undefined;
  }

  // Whether one of its things is the white robe the shard dresses a raised ghost in.
  deathRobe(serial: number) {
    return isDeathRobe({ graphic: this.graphics.get(serial) ?? 0, hue: this.hues.get(serial) });
  }

  // Whether it sits on a mount (the mount layer worn).
  riding() {
    for (const [serial, layer] of this.layers) if (layer === 25 && this.parents.get(serial) === this.self) return true;
    return false;
  }

  // Everything it has and could have, by where it is: worn (by layer), in its pack, in its bank box,
  // on the ground within `range` of `here` (only what may be moved) and in the corpses about.
  has(here: { x: number; y: number } | undefined, range: number) {
    type Held = { serial: number; name: string; amount: number };
    const worn: (Held & { layer: number })[] = [];
    const pack: Held[] = [];
    const bank: Held[] = [];
    for (const [serial, item] of this.owned) {
      const layer = this.layers.get(serial);
      if (this.inBank(serial)) {
        if (serial !== this.bank) bank.push({ serial, ...item });
      } else if (this.parents.get(serial) === this.self && layer !== undefined) {
        // Its backpack is where its things are, not a thing it wears.
        if (layer !== 21 && layer !== 29) worn.push({ serial, ...item, layer });
      } else if (this.belongs(serial)) pack.push({ serial, ...item });
    }
    const ground: (Held & { x: number; y: number; z: number })[] = [];
    if (here)
      for (const [serial, spot] of this.spots)
        if (
          !this.owned.has(serial) &&
          !this.mobiles.has(serial) &&
          !this.fixed.has(serial) &&
          !this.corpses.has(serial) &&
          Math.max(Math.abs(spot.x - here.x), Math.abs(spot.y - here.y)) <= range
        )
          ground.push({ serial, name: this.called(serial), amount: this.counts.get(serial) ?? 1, ...spot });
    const corpses = [...this.corpses].map(([serial, name]) => ({
      serial,
      name,
      ...this.spots.get(serial),
      items: [...this.parents]
        .filter(([, parent]) => parent === serial)
        .map(([item]) => ({ serial: item, name: this.called(item), amount: this.counts.get(item) ?? 1 }))
    }));
    return { worn, pack, bank, ground, corpses };
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
    if (typeof data.graphic === 'number' && isDeathRobe({ graphic: data.graphic, hue: data.hue as number | undefined }))
      return 'DeathRobe';
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

  private belongs(serial: number) {
    for (let at: number | undefined = serial, hops = 0; at !== undefined && hops < 16; hops++) {
      if (at === this.self) return true;
      at = this.parents.get(at);
    }
    return false;
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
