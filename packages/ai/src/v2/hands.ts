import { GARGOYLE_BODIES } from '@gemwright/common/game/bodies';
import { doorGraphics } from '@gemwright/common/game/rules';
import { Layer } from '@gemwright/network/layers';
import { Opcode } from '@gemwright/network/opcodes';
import { Actions } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';

import { routeSeed } from '../path-search';
import { directionTo, type Terrain } from '../terrain';
import { reportedBankGold } from '../v1/bank-gold';
import { observedTerrain } from '../v1/observed-terrain';
import type { Encounter } from './encounter';
import { takeMoongate } from './moongate';
import { type Locomotion, motion } from './motion';
import type { Step } from './options';
import type { Reach } from './reach';

const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
// "You must wait to perform another action" (ServUO 500119): the shard's pace between uses.
const busy = 500119;
// How close it must stand to open or take from something (ServUO: 2 tiles).
const reach = 2;
// Farther than this a walk follows the way it knows; nearer, a route search alone.
const FAR = 48;
const doors: ReadonlySet<number> = new Set(doorGraphics.flat());

// Its hands: each step as the client does it, and only what the client could do then (the
// arbiter is the client's own physics). A step that the world refuses ends what it was doing:
// false, and the mind learns from what came of it. `going` says whether to keep at it.
export class Hands {
  constructor(
    private readonly session: PlayerSession,
    private readonly terrain: Terrain | undefined,
    // Its own mount while it stands off it (the mind knows which one is its own).
    private readonly mount: () => number | undefined = () => undefined,
    // What it calls a thing, and what that is worth to it: what it takes from a corpse.
    private readonly call: (serial: number) => string | undefined = () => undefined,
    private readonly worth: (serial: number) => number = () => 0,
    private readonly locomotion?: Locomotion,
    private readonly canFollowThrough: () => boolean = () => true,
    private readonly encounter?: Encounter
  ) {
    if (terrain?.directory) this.terrain = observedTerrain(terrain, session);
  }

  private get world() {
    return this.session.world;
  }

  async do(step: Step, going: () => boolean | Promise<boolean>): Promise<boolean> {
    if (!(await going())) {
      if (this.world.target && this.session.phase === 'ready') this.session.target(null);
      return false;
    }
    switch (step.verb) {
      case 'treat':
        return this.encounter?.treat(step.treatment, going) ?? false;
      case 'escape':
        return (
          this.encounter?.escape((point, range) => this.walk({ ...point, range, running: true }, going), going) ?? false
        );
      case 'war':
        if (this.world.warMode !== step.enabled) this.session.setWarMode(step.enabled);
        return true;
      case 'walk':
        return this.walk(step, going);
      case 'use':
        return this.use(step.serial);
      case 'equip':
        return this.equip(step.serial, step.layer);
      case 'dismount':
        return this.dismount();
      case 'drop':
        return this.drop(step.serial);
      case 'target':
        return this.target(step);
      case 'fight':
        return this.fight(step.serial, going);
      case 'seek':
        return this.seek(step, going);
      case 'balance': {
        const heard = new Set(this.world.journal);
        this.session.say('balance');
        return this.until(
          () =>
            this.world.journal.some(
              (entry) => !heard.has(entry) && reportedBankGold(entry.cliloc ?? 0, entry.arguments ?? '') !== undefined
            ),
          3000
        );
      }
      case 'say':
        this.session.say(step.text);
        return true;
      case 'deposit':
        return this.deposit(step.items, going);
      case 'withdraw':
        return this.withdraw(step.items);
      case 'buy':
        return this.buy(step);
      case 'sell-to':
        return this.sellTo(step, going);
      case 'sell':
        return this.sell(step.vendor, step.items);
      case 'rest':
        await Bun.sleep(step.seconds * 1000);
        return true;
    }
  }

  // What it knows of the way to far places (reach.ts), once the land is known.
  reach?: Reach;

  // To within range: somewhere far along the way it knows (each leg walked, teleporters stepped on),
  // and with no way known there, not at all; somewhere near straight on.
  private async walk(
    goal: { x: number; y: number; range: number; running?: boolean; flying?: boolean },
    going: () => boolean | Promise<boolean>
  ) {
    const here = this.world.position;
    if (!this.reach || !here || away(here, goal) <= FAR) return this.stepTo(goal, going);
    const route = this.reach.route(here, { x: goal.x, y: goal.y, z: here.z }, routeSeed(goal));
    if (!route) return false;
    let last: { x: number; y: number } = here;
    for (const [i, leg] of route.legs.entries()) {
      if (leg.kind === 'gate') {
        if (!(await takeMoongate(this.session, leg, (goal, going) => this.stepTo(goal, going), going))) return false;
        last = this.world.position ?? leg;
        continue;
      }
      if (leg.kind === 'teleport') {
        if (!(await this.stepTo({ x: leg.x, y: leg.y, range: 0 }, going))) return false;
        // The shard moves it the moment it stands there.
        await this.until(() => away(this.world.position ?? leg, leg) > 1, 3000);
        last = this.world.position ?? leg;
        continue;
      }
      const final = i === route.legs.length - 1;
      if (
        !final &&
        this.terrain?.geometry?.houses?.some(
          (house) => leg.x >= house.minX && leg.x <= house.maxX && leg.y >= house.minY && leg.y <= house.maxY
        )
      )
        continue;
      const beforeTeleport = route.legs[i + 1]?.kind === 'teleport';
      // Waypoints a walk apart: between them the route search finds its own line.
      if (!final && !beforeTeleport && away(last, leg) < FAR) continue;
      if (!(await this.stepTo(final ? goal : { x: leg.x, y: leg.y, range: beforeTeleport ? 1 : 4 }, going)))
        return false;
      last = this.world.position ?? leg;
    }
    return true;
  }

  // Along a route search to within range. A closed door in the way is opened; a step still refused
  // is something in the way, routed round on the next try.
  private async stepTo(
    goal: { x: number; y: number; range: number; running?: boolean; flying?: boolean },
    going: () => boolean | Promise<boolean>
  ) {
    const flying =
      goal.flying ??
      motion(this.world, Math.max(0, away(this.world.position ?? goal, goal) - goal.range), this.locomotion).flying;
    if (flying !== undefined && !!((this.world.entities.get(this.world.serial ?? -1)?.flags ?? 0) & 4) !== flying) {
      this.session.toggleFlying();
      if (
        !(await this.until(
          () => !!((this.world.entities.get(this.world.serial ?? -1)?.flags ?? 0) & 4) === flying,
          3500
        ))
      )
        return false;
    }
    await this.ride(goal, going);
    const refusals = new Set<string>();
    for (let progress = true; progress && (await going()); ) {
      const blockedBefore = refusals.size;
      const here = this.world.position;
      if (!here) return false;
      if (away(here, goal) <= goal.range) return true;
      const blocked = new Set([...refusals, ...(this.encounter?.blocked() ?? [])]);
      const path = this.terrain
        ? await this.terrain.pathAsync(here, goal, goal.range, blocked, undefined, undefined, true)
        : [{ x: goal.x, y: goal.y, z: here.z }];
      if (!path?.length) return false;
      let stopped = false;
      for (const next of path) {
        if (!(await going())) return false;
        if (this.encounter?.blocked().has(`${next.x},${next.y}`)) break;
        const at = this.world.position;
        if (!at) return false;
        if (at.x === next.x && at.y === next.y) continue;
        const direction = directionTo(at, next);
        const mode = motion(this.world, Math.max(0, away(at, goal) - goal.range), this.locomotion);
        const running = goal.running ?? mode.running;
        // A step in a new direction first turns to face it.
        if (at.direction !== direction && !(await this.session.walk(direction, undefined, running))) {
          refusals.add(`${next.x},${next.y}`);
          stopped = true;
          break;
        }
        const began = Date.now();
        const stamina = this.world.status?.stamina;
        if (
          !(await this.session.walk(direction, next.z, running)) &&
          !(await this.throughDoor(next, direction, running))
        ) {
          refusals.add(`${next.x},${next.y}`);
          stopped = true;
          break;
        }
        const moved = this.world.position;
        const tiles = moved ? away(at, moved) : 0;
        if (tiles)
          this.locomotion?.observed(
            mode.key.replace(/(?:run|walk)$/, running ? 'run' : 'walk'),
            tiles,
            (Date.now() - began) / 1000,
            stamina === undefined ? 0 : stamina - (this.world.status?.stamina ?? stamina)
          );
      }
      const there = this.world.position ?? here;
      if (away(there, goal) <= goal.range) return true;
      progress = (stopped && refusals.size > blockedBefore) || there.x !== here.x || there.y !== here.y;
    }
    return false;
  }

  // Into its hand: whatever it holds there (and a shield, for a two-handed tool) goes to its pack first.
  private async equip(serial: number, layer: number) {
    const world = this.world;
    const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Backpack);
    if (!pack || !layer) return false;
    const freeing = layer === Layer.TwoHanded ? [Layer.OneHanded, Layer.TwoHanded] : [layer];
    for (const held of [...world.entities.values()])
      if (
        held.parent === world.serial &&
        held.layer !== undefined &&
        freeing.includes(held.layer) &&
        held.serial !== serial
      )
        await this.session.moveItem(held.serial, pack.serial);
    await this.session.equipItem(serial, layer);
    return this.until(() => world.entities.get(serial)?.parent === world.serial, 2000);
  }

  // Putting something down on the tile it stands on, at the height the shard has for it.
  private async drop(serial: number) {
    if (!this.world.entities.has(serial)) return false;
    await this.session.resyncPosition();
    await this.session.dropAtFeet(serial);
    return !this.world.entities.get(serial)?.parent;
  }

  // On foot with its mount in view and far enough to go: onto it first, riding being the faster way
  // (ServUO: a step every 0.2 seconds mounted, 0.4 on foot) once the steps it saves outweigh the
  // second or so each of getting on and, later, off.
  private async ride(goal: { x: number; y: number; range: number }, going: () => boolean | Promise<boolean>) {
    if (GARGOYLE_BODIES.has(this.world.entities.get(this.world.serial ?? -1)?.graphic ?? 0)) return;
    const mount = this.mount();
    const here = this.world.position;
    const at = mount === undefined ? undefined : this.world.entities.get(mount)?.position;
    const saved = (away(here ?? goal, goal) - goal.range - away(here ?? goal, at ?? goal)) * (0.4 - 0.2);
    if (mount === undefined || !here || !at || this.riding() || saved <= 2) return;
    if (away(here, at) > 1) {
      const path = this.terrain ? await this.terrain.pathAsync(here, at, 1) : [];
      for (const next of path ?? []) {
        const now = this.world.position;
        if (!(await going()) || !now || !(await this.session.walk(directionTo(now, next), next.z))) return;
      }
    }
    this.session.use(mount);
    await this.until(() => this.riding(), 3000);
  }

  private riding() {
    const world = this.world;
    return [...world.entities.values()].some((e) => e.parent === world.serial && e.layer === Layer.Mount);
  }

  // Off its mount: using itself while riding.
  private async dismount() {
    const world = this.world;
    if (!this.riding() || world.serial === null) return true;
    this.session.use(world.serial);
    return this.until(() => !this.riding(), 3000);
  }

  // A closed door on the tile it was refused: opened, and the step tried again.
  private async throughDoor(next: { x: number; y: number }, direction: number, running: boolean) {
    const door = [...this.world.entities.values()].find(
      (e) => e.kind === 'item' && doors.has(e.graphic) && e.position?.x === next.x && e.position.y === next.y
    );
    if (!door) return false;
    this.session.use(door.serial);
    await Bun.sleep(500);
    return this.session.walk(direction, undefined, running);
  }

  // Using an item; a tool brings up a cursor for what to use it on. The shard's pace is kept: told
  // to wait, it waits as long as it took and tries once more.
  private async use(serial: number, ready = () => !!this.world.target, going = () => true) {
    if (!this.world.entities.has(serial)) return false;
    for (let tries = 0; tries < 2 && going(); tries++) {
      const asked = Date.now();
      const heard = this.world.journal.length;
      this.session.use(serial);
      const answered = await this.until(
        () => !going() || ready() || this.world.journal.slice(heard).some((e) => e.cliloc === busy),
        3000
      );
      if (!going()) return false;
      if (ready()) return true;
      if (!answered || !this.world.journal.slice(heard).some((e) => e.cliloc === busy)) return answered;
      await Bun.sleep(Date.now() - asked + 500);
    }
    return false;
  }

  // Answering the cursor, then waiting for the world to answer back (a message, something gained).
  private async target(step: Extract<Step, { verb: 'target' }>) {
    if (!this.world.target) return false;
    const heard = this.world.journal.length;
    this.session.target(
      step.serial !== undefined
        ? { serial: step.serial, x: 0, y: 0, z: 0, graphic: 0 }
        : { serial: 0, x: step.x ?? 0, y: step.y ?? 0, z: step.z ?? 0, graphic: step.graphic ?? 0 }
    );
    // The tool's targeting prompt is not a harvest result.
    const answered = await this.until(() => this.world.journal.slice(heard).some((e) => e.cliloc !== 503033), 8000);
    if (!answered) return false;
    return true;
  }

  private async sellTo(step: Extract<Step, { verb: 'sell-to' }>, going: () => boolean | Promise<boolean>) {
    const seller = () =>
      [...this.world.entities.values()].find(
        (e) =>
          e.kind === 'mobile' &&
          e.position &&
          (this.call(e.serial)
            ?.split('/')
            .some((type) => step.types.includes(type)) ||
            (this.call(e.serial) === 'Person' && away(e.position, step) <= (step.range ?? 0))) &&
          away(this.world.position ?? step, e.position) <= reach
      );
    await this.walk({ ...step, range: 0 }, () => !seller() && going());
    const vendor = seller();
    if (!vendor) return false;
    const items = [...this.world.entities.values()].filter(
      (e) =>
        e.parent !== this.world.serial &&
        this.call(e.serial)?.startsWith('my ') &&
        step.names.some((name) =>
          name.split('/').some((type) => this.call(e.serial)?.slice(3).split('/').includes(type))
        )
    );
    return this.sell(
      vendor.serial,
      items.map((e) => e.serial)
    );
  }

  private async seek(step: Extract<Step, { verb: 'seek' }>, going: () => boolean | Promise<boolean>) {
    const target = () =>
      [...this.world.entities.values()]
        .filter(
          (e) =>
            e.kind === 'mobile' &&
            e.serial !== this.world.serial &&
            e.position &&
            this.call(e.serial)?.split('/').includes(step.kind)
        )
        .sort(
          (a, b) =>
            away(this.world.position ?? step, a.position ?? step) -
            away(this.world.position ?? step, b.position ?? step)
        )[0];
    if (!target()) await this.walk({ ...step, range: step.range }, () => !target() && going());
    const seen = target();
    if (!seen) return false;
    return this.fight(seen.serial, going);
  }

  // Attacking, and staying beside it until it falls, leaves, is out of reach or is given up.
  private async fight(serial: number, going: () => boolean | Promise<boolean>) {
    if (this.world.entities.get(serial)?.kind !== 'mobile') return false;
    if (this.encounter?.allows(serial) === false) {
      if (this.world.warMode) this.session.setWarMode(false);
      return false;
    }
    const started = Date.now();
    try {
      const target = this.world.entities.get(serial)?.position;
      const start = this.world.position;
      if (!target || !start || (away(start, target) > 1 && !(await this.walk({ ...target, range: 1 }, going))))
        return false;
      await this.session.attack(serial);
      while (this.world.entities.has(serial) && (await going())) {
        if (this.encounter?.allows(serial) === false) return false;
        const them = this.world.entities.get(serial)?.position;
        const here = this.world.position;
        if (!them || !here) break;
        // Out of reach and no way to close in: it gives up.
        if (away(here, them) > 1 && !(await this.walk({ x: them.x, y: them.y, range: 1 }, going))) return false;
        await Bun.sleep(500);
        if (this.world.combatant !== serial && this.world.entities.has(serial)) await this.session.attack(serial);
      }
    } finally {
      // The fight over, won or not, out of war mode, as a player sheathes.
      if (this.world.warMode && this.session.phase === 'ready') this.session.setWarMode(false);
    }
    if (this.world.entities.has(serial)) return false;
    const corpse = this.world.deaths?.get(serial)?.corpse;
    if (corpse !== undefined) {
      const safe = () =>
        this.canFollowThrough() &&
        ![...(this.world.swings?.entries() ?? [])].some(
          ([attacker, swing]) =>
            swing.target === this.world.serial && swing.at >= started && this.world.entities.has(attacker)
        );
      if (safe()) await this.loot(corpse, safe);
    }
    return true;
  }

  // The corpse of what it just killed: opened, and whatever in it is worth something taken into its
  // pack, gold first, as long as the pack has room (the shard refuses more).
  private async loot(serial: number, going: () => boolean) {
    const world = this.world;
    await this.until(() => !going() || !!world.entities.get(serial)?.position, 2000);
    const at = world.entities.get(serial)?.position;
    const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Backpack);
    if (!at || !pack || !going() || (world.status && world.status.weight >= world.status.maxWeight)) return false;
    if (!(await this.walk({ ...at, range: reach }, going))) return false;
    if (!(await this.use(serial, () => [...world.entities.values()].some((e) => e.parent === serial), going)))
      return false;
    const inside = [...world.entities.values()]
      .filter((e) => e.parent === serial && this.worth(e.serial) > 0)
      .sort(
        (a, b) => (this.call(b.serial)?.startsWith('Gold') ? 1 : 0) - (this.call(a.serial)?.startsWith('Gold') ? 1 : 0)
      );
    for (const item of inside) {
      if (!(await going()) || (world.status && world.status.weight >= world.status.maxWeight)) break;
      await this.session.moveItem(item.serial, pack.serial);
    }
    return true;
  }

  // From whoever near it sells it, as a player asks: the people nearest first, each one's context
  // menu looked at for a buy entry, its selling list read for the item, and one bought (the shard
  // takes the gold from its pack or its bank).
  private async buy(step: Extract<Step, { verb: 'buy' }>) {
    const world = this.world;
    const here = world.position;
    const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Backpack);
    if (!here || !pack) return false;
    const people = [...world.entities.values()]
      .filter((e) => e.kind === 'mobile' && e.serial !== world.serial && e.position)
      .sort((a, b) => away(here, a.position ?? here) - away(here, b.position ?? here));
    for (const vendor of people) {
      const entry = (await this.session.context(vendor.serial)).find((e) => e.cliloc === Actions.buy && !(e.flags & 1));
      if (!entry) continue;
      // The list arrives keyed by the vendor's stock containers, not by the vendor.
      world.buyOffers.clear();
      const listed = world.received.get(Opcode.vendorBuyList) ?? 0;
      this.session.selectContext(vendor.serial, entry.index);
      if (!(await this.until(() => (world.received.get(Opcode.vendorBuyList) ?? 0) > listed, 2500))) continue;
      const offer = [...world.buyOffers.values()]
        .flat()
        .filter((o) => world.entities.get(o.serial)?.graphic === step.graphic)
        .sort((a, b) => a.price - b.price)[0];
      if (!offer) continue;
      await this.session.purchaseItem(vendor.serial, offer.serial, pack.serial, 1, offer.price);
      return true;
    }
    return false;
  }

  // Out of its bank box into its pack once the banker opens it.
  private async withdraw(items: number[]) {
    const world = this.world;
    const box = () => [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Bank);
    const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Backpack);
    if (!pack || !(await this.until(() => !!box(), 3000))) return false;
    for (const serial of items) if (world.entities.has(serial)) await this.session.moveItem(serial, pack.serial);
    return true;
  }

  // Into its bank box once the banker opens it.
  private async deposit(items: number[], going: () => boolean | Promise<boolean>) {
    const world = this.world;
    const box = () => [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Bank);
    if (!(await this.until(() => !!box(), 3000))) return false;
    for (const serial of items) {
      const bank = box();
      if (!(await going()) || !bank || !world.entities.has(serial)) break;
      await this.session.moveItem(serial, bank.serial);
    }
    return true;
  }

  // A vendor's buying list from its context menu, and every offered stack of what it meant to sell.
  private async sell(vendor: number, items: number[]) {
    const entry = (await this.session.context(vendor)).find((e) => e.cliloc === Actions.sell && !(e.flags & 1));
    if (!entry) return false;
    this.world.sellOffers.delete(vendor);
    this.session.selectContext(vendor, entry.index);
    if (!(await this.until(() => this.world.sellOffers.has(vendor), 2500))) return false;
    const wanted = new Set(items);
    const offers = (this.world.sellOffers.get(vendor) ?? []).filter((o) => wanted.has(o.serial) && o.price > 0);
    if (!offers.length) return false;
    await this.session.sell(
      vendor,
      offers.map((o) => ({ serial: o.serial, amount: o.amount }))
    );
    return true;
  }

  private async until(done: () => boolean, ms: number) {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (done()) return true;
    return done();
  }
}
