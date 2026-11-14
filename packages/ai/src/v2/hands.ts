import { GARGOYLE_BODIES } from '@gemwright/common/game/bodies';
import { isDeathRobe } from '@gemwright/common/game/items';
import { classesShowing, doorGraphics, skillOf } from '@gemwright/common/game/rules';
import { skillId } from '@gemwright/common/game/skills';
import { CommandRejected } from '@gemwright/network/errors';
import { Layer } from '@gemwright/network/layers';
import { Opcode } from '@gemwright/network/opcodes';
import { Actions } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';

import { routeSeed } from '../path-search';
import { directionTo, type Terrain } from '../terrain';
import { reportedBankGold } from '../v1/bank-gold';
import { observedTerrain } from '../v1/observed-terrain';
import { bankCount, descendants, seeBank } from './bank-space';
import { CareHands } from './care-hands';
import type { Encounter } from './encounter';
import { facts } from './knowledge';
import { takeMoongate } from './moongate';
import { bodyOnScreen, type Locomotion, motion } from './motion';
import type { Step } from './options';
import { screenOf } from './perceive';
import type { Reach } from './reach';
import { TrainingHands } from './training-hands';

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
// ServUO AnimalTaming's last word: accepted as master (or already its own), and every way it ends
// otherwise (the roll failed, refused at the cursor, or broken off).
const tamed: ReadonlySet<number> = new Set([502799, 502797]);
const untamed: ReadonlySet<number> = new Set([
  502798, // You fail to tame the creature.
  502806, // You have no chance of taming this creature.
  502805, // You seem to anger the beast!
  1049655, // That creature cannot be tamed.
  502804, // That animal looks tame already.
  1049653, // That creature can only be tamed by males.
  1049652, // That creature can only be tamed by females.
  502801, // You can't tame that!
  1049611, // You have too many followers to tame that creature.
  1005615, // This animal has had too many owners and is too upset for you to tame.
  1054025, // You must subdue this creature before you can tame it!
  1042590, // You cannot tame this creature.
  502802, // Someone else is already taming this.
  502469, // That being cannot be tamed.
  502795, // You are too far away to continue taming.
  502796, // You are dead, and cannot continue taming.
  1049654, // You do not have a clear path to the animal you are taming...
  502794 // The animal is too angry to continue taming.
]);

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
    return screenOf(this.session);
  }

  async do(step: Step, going: () => boolean | Promise<boolean>): Promise<boolean> {
    if (!(await going())) {
      if (this.world.target && this.session.phase === 'ready') this.session.target(null);
      return false;
    }
    const care = new CareHands(this.session, (kind, data) => this.notice?.(kind, data), this.call);
    switch (step.verb) {
      case 'learn-spell':
        try {
          return await new TrainingHands(this.session, (kind, data) => this.notice?.(kind, data)).learn(step, going);
        } finally {
          if (this.world.target && this.session.phase === 'ready') this.session.target(null);
        }
      case 'craft':
        return new TrainingHands(this.session, (kind, data) => this.notice?.(kind, data)).craft(step, going);
      case 'pickup':
        return care.pickup(step.serial, step.amount, going);
      case 'recover-corpse': {
        const recovered = await care.recover(step.serial, going);
        if (!recovered && (await going())) this.notice?.('care', { action: 'corpse-failed' });
        return recovered;
      }
      case 'help':
        return care.help(going);
      case 'claim':
        return care.claim(going);
      case 'practice':
        try {
          return await care.practice(step, going);
        } finally {
          if (this.world.target && this.session.phase === 'ready') this.session.target(null);
        }
      case 'guards':
        return care.guards(step.serial);
      case 'clear-bank': {
        const moved = await this.withdraw([step.serial], going);
        if (moved)
          this.notice?.('care', {
            action: 'clear-bank',
            key: `cleared ${step.serial}`,
            until: Date.now() + 24 * 3_600_000
          });
        return moved;
      }
      case 'treat':
        return this.encounter?.treat(step.treatment, going) ?? false;
      case 'tame':
        return this.tame(step.serial, going);
      case 'escape':
        return (
          this.encounter?.escape(
            (point, range) => this.walk({ ...point, range, running: true }, going),
            going,
            step.to
          ) ?? false
        );
      case 'war':
        if (this.world.warMode !== step.enabled) this.session.setWarMode(step.enabled);
        return true;
      case 'walk':
        return this.walk(step, going);
      case 'use':
        return this.use(step.serial, undefined, undefined, step.gump);
      case 'inspect':
        if (!(await this.until(() => this.world.entities.has(step.serial), 3000))) return false;
        await this.session.inspectProperties(step.serial);
        return facts(this.world.entities.get(step.serial)?.properties ?? []).weight !== undefined;
      case 'stow': {
        if (!this.world.entities.has(step.serial)) return this.gone(step.serial, 'pack');
        if (isDeathRobe(this.world.entities.get(step.serial) ?? { graphic: 0 })) return false;
        const pack = [...this.world.entities.values()].find(
          (e) => e.parent === this.world.serial && e.layer === Layer.Backpack
        );
        if (!pack) return false;
        await this.session.moveItem(step.serial, pack.serial);
        return this.until(() => this.world.entities.get(step.serial)?.parent === pack.serial, 2000);
      }
      case 'equip':
        return this.equip(step.serial, step.layer);
      case 'dismount':
        return this.dismount();
      case 'drop':
        return this.drop(step.serial, step.amount);
      case 'target':
        return this.target(step);
      case 'fight':
        return this.fight(step.serial, going, step.back);
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
        if (step.text.toLowerCase() === 'bank') {
          if (
            !(await this.until(
              () =>
                [...this.world.entities.values()].some((e) => e.parent === this.world.serial && e.layer === Layer.Bank),
              3000
            ))
          )
            return false;
          return seeBank(this.session, going);
        }
        return true;
      case 'deposit':
        return this.deposit(step.items, going, step.amounts);
      case 'withdraw':
        return this.withdraw(step.items, going, step.amounts);
      case 'buy':
        return this.buy(step, going);
      case 'sell-to':
        return this.sellTo(step, going);
      case 'sell':
        return this.sell(step.vendor, step.items, going);
      // A menu is answered by what it is: whichever opening of it the shard has sent, each under a
      // serial of its own (ServUO Gump), once it has arrived.
      case 'gump-response': {
        const open = () => [...(this.world.gumps?.values() ?? [])].find((g) => g.id === step.gump);
        if (!open() && !(await this.until(() => !!open(), 3000))) return false;
        const gump = open();
        if (!gump) return false;
        this.session.replyGump(gump.serial, step.gump, step.button, []);
        return true;
      }
      case 'rest':
        for (const end = Date.now() + step.seconds * 1000; Date.now() < end; ) {
          if (!(await going())) return false;
          await Bun.sleep(Math.min(250, end - Date.now()));
        }
        if (this.session.refreshStatus) await this.session.refreshStatus();
        return true;
    }
  }

  // What it knows of the way to far places (reach.ts), once the land is known.
  reach?: Reach;
  canReach?: (goal: { x: number; y: number; z?: number }) => boolean;
  notice?: (kind: string, data: object) => void;
  // A walk that did not get there: closed by the land, or only by the creatures about (`hemmed`).
  blocked?: (
    from: { x: number; y: number; z: number; map: number },
    goal: { x: number; y: number; z: number },
    hemmed: boolean
  ) => void;
  // Told when a thing of its own it reached for is not there: in its pack (or worn), or in its bank
  // box with the box open.
  missing?: (serial: number, where: 'pack' | 'bank') => void;
  // The walk under way was stopped by the creatures about rather than by the land.
  private hemmed = false;

  // To within range: somewhere far along the way it knows (each leg walked, teleporters stepped on),
  // and with no way known there, not at all; somewhere near straight on.
  private async walk(
    goal: { x: number; y: number; z?: number; range: number; running?: boolean; flying?: boolean; trying?: boolean },
    going: () => boolean | Promise<boolean>
  ) {
    if (!goal.trying && this.canReach && !this.canReach(goal)) return false;
    const from = this.world.position && { ...this.world.position, map: this.world.map ?? 1 };
    let interrupted = false;
    const keep = async () => {
      const yes = await going();
      if (!yes) interrupted = true;
      return yes;
    };
    this.hemmed = false;
    const reached = await this.follow(goal, keep);
    if (!reached && !interrupted && from && (await keep()))
      this.blocked?.(from, { x: goal.x, y: goal.y, z: goal.z ?? from.z }, this.hemmed);
    return reached;
  }

  private async follow(
    goal: { x: number; y: number; z?: number; range: number; running?: boolean; flying?: boolean },
    going: () => boolean | Promise<boolean>
  ) {
    const here = this.world.position;
    if (!this.reach || !here || away(here, goal) <= FAR) return this.stepTo(goal, going);
    // At the height it is going to when that is known (a spawner's), else at its own.
    const route = this.reach.route(here, { x: goal.x, y: goal.y, z: goal.z ?? here.z }, routeSeed(goal));
    if (!route) return false;
    let last: { x: number; y: number } = here;
    for (const [i, leg] of route.legs.entries()) {
      if (leg.kind === 'gate') {
        if (!(await takeMoongate(this.session, leg, (goal, going) => this.stepTo(goal, going), going))) return false;
        // Put somewhere else by the gate: where exactly, as the shard has it.
        await this.session.resyncPosition();
        last = this.world.position ?? leg;
        continue;
      }
      if (leg.kind === 'teleport') {
        // The shard moves it the moment it stands there: the step onto it is done once it is gone
        // from beside it, not when it stands on the tile it was taken from.
        const sent = () => away(this.world.position ?? leg, leg) > 1;
        await this.stepTo({ x: leg.x, y: leg.y, range: 0 }, async () => !sent() && (await going()));
        if (!sent() && !(await this.until(sent, 3000))) return false;
        await this.session.resyncPosition();
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
      motion(
        bodyOnScreen(this.world),
        Math.max(0, away(this.world.position ?? goal, goal) - goal.range),
        this.locomotion
      ).flying;
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
      const around = this.encounter?.blocked() ?? new Set<string>();
      const blocked = new Set([...refusals, ...around]);
      const path = this.terrain
        ? await this.terrain.pathAsync(here, goal, goal.range, blocked, undefined, undefined, true)
        : [{ x: goal.x, y: goal.y, z: here.z }];
      if (!path?.length) {
        // Closed only by the creatures about, not by the land: no failed route, just not now.
        if (
          around.size &&
          this.terrain &&
          (await this.terrain.pathAsync(here, goal, goal.range, refusals, undefined, undefined, true))?.length
        )
          this.hemmed = true;
        return false;
      }
      let stopped = false;
      for (const next of path) {
        if (!(await going())) return false;
        if (this.encounter?.blocked().has(`${next.x},${next.y}`)) break;
        const at = this.world.position;
        if (!at) return false;
        if (at.x === next.x && at.y === next.y) continue;
        const direction = directionTo(at, next);
        const mode = motion(bodyOnScreen(this.world), Math.max(0, away(at, goal) - goal.range), this.locomotion);
        const running = goal.running ?? mode.running;
        // A step in a new direction first turns to face it.
        if (at.direction !== direction && !(await this.session.walk(direction, undefined, running))) {
          refusals.add(`${next.x},${next.y}`);
          stopped = true;
          // Refused: where it stands is the shard's word now, not the client's guess (0x22).
          await this.session.resyncPosition();
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
          await this.session.resyncPosition();
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
    if (!this.world.entities.has(serial)) return this.gone(serial, 'pack');
    if (isDeathRobe(this.world.entities.get(serial) ?? { graphic: 0 })) return false;
    const world = this.world;
    const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Backpack);
    if (!pack || !layer) return false;
    const freeing = layer === Layer.TwoHanded ? [Layer.OneHanded, Layer.TwoHanded] : [layer];
    // A one-handed weapon needs the other hand free of a two-handed one (a shield may stay).
    const twoHandedWeapon = (held: { graphic: number; layer?: number }) =>
      layer === Layer.OneHanded &&
      held.layer === Layer.TwoHanded &&
      classesShowing(held.graphic).some((type) => skillOf(type) !== undefined);
    for (const held of [...world.entities.values()])
      if (
        held.parent === world.serial &&
        held.layer !== undefined &&
        (freeing.includes(held.layer) || twoHandedWeapon(held)) &&
        held.serial !== serial
      )
        await this.session.moveItem(held.serial, pack.serial);
    // Refused, it is never offered to be worn again.
    const refused = () => this.notice?.('wear-refused', { serial });
    try {
      await this.session.equipItem(serial, layer);
    } catch (error) {
      if (error instanceof CommandRejected) refused();
      throw error;
    }
    if (await this.until(() => world.entities.get(serial)?.parent === world.serial, 2000)) return true;
    refused();
    return false;
  }

  // Putting something down on the tile it stands on, at the height the shard has for it.
  private async drop(serial: number, amount?: number) {
    if (!this.world.entities.has(serial)) return this.gone(serial, 'pack');
    await this.session.resyncPosition();
    await this.session.dropAtFeet(serial, undefined, amount);
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

  // Using an item; a tool brings up a cursor for what to use it on, or a menu of what it offers
  // (`menu`: the gump this use opens, already open from the last time it did). The shard's pace is
  // kept: told to wait, it waits as long as it took and tries once more.
  private async use(serial: number, ready = () => !!this.world.target, going = () => true, menu?: number) {
    if (!this.world.entities.has(serial)) return this.gone(serial, 'pack');
    const open =
      menu === undefined ? undefined : () => [...(this.world.gumps?.values() ?? [])].some((g) => g.id === menu);
    for (let tries = 0; tries < 2 && going(); tries++) {
      const asked = Date.now();
      const heard = this.world.heard;
      const opened = new Set(this.world.gumps?.values() ?? []);
      const replied = () =>
        [...(this.world.gumps?.values() ?? [])].some((g) => !opened.has(g) && (menu === undefined || g.id === menu)) ||
        !!open?.();
      this.session.use(serial);
      const settled = await this.until(
        () => !going() || ready() || replied() || this.world.journalSince(heard).some((e) => e.cliloc === busy),
        3000
      );
      if (!going()) return false;
      if (ready() || replied()) return true;
      if (!settled || !this.world.journalSince(heard).some((e) => e.cliloc === busy)) return settled;
      await Bun.sleep(Date.now() - asked + 500);
    }
    return false;
  }

  // Answering the cursor, then waiting for the world to answer back (a message, something gained).
  private async target(step: Extract<Step, { verb: 'target' }>) {
    if (!this.world.target) return false;
    const heard = this.world.heard;
    this.session.target(
      step.serial !== undefined
        ? { serial: step.serial, x: 0, y: 0, z: 0, graphic: 0 }
        : { serial: 0, x: step.x ?? 0, y: step.y ?? 0, z: step.z ?? 0, graphic: step.graphic ?? 0 }
    );
    // The tool's targeting prompt is not a harvest result.
    const answered = await this.until(() => this.world.journalSince(heard).some((e) => e.cliloc !== 503033), 8000);
    if (!answered) return false;
    return true;
  }

  private async sellTo(step: Extract<Step, { verb: 'sell-to' }>, going: () => boolean | Promise<boolean>) {
    // One whose title names the trade; else, until titles are known, an untitled person standing
    // where that trade's spawner keeps it.
    const seller = () => {
      const near = [...this.world.entities.values()].filter(
        (e) => e.kind === 'mobile' && e.position && away(this.world.position ?? step, e.position) <= reach
      );
      return (
        near.find((e) =>
          this.call(e.serial)
            ?.split('/')
            .some((type) => step.types.includes(type))
        ) ??
        near.find((e) => this.call(e.serial) === 'Person' && e.position && away(e.position, step) <= (step.range ?? 0))
      );
    };
    await this.walk({ ...step, range: 0 }, () => !seller() && going());
    const vendor = seller();
    if (!vendor) return false;
    const pack = [...this.world.entities.values()].find(
      (e) => e.parent === this.world.serial && e.layer === Layer.Backpack
    );
    const carried = new Set(pack ? descendants(this.world.entities.values(), pack.serial).map((e) => e.serial) : []);
    const items = [...this.world.entities.values()].filter(
      (e) =>
        carried.has(e.serial) &&
        e.parent !== this.world.serial &&
        !step.except?.includes(e.serial) &&
        !isDeathRobe(e) &&
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
    const arrived = !target() && (await this.walk({ ...step, range: step.range }, () => !target() && going()));
    const seen = target();
    // There, with none of its kind about: the going is done, and what it sees there is what it next
    // weighs (the spawner's kind is remembered gone).
    if (!seen) return arrived;
    return this.fight(seen.serial, going);
  }

  // Attacking, and staying beside it until it falls, leaves, is out of reach or is given up.
  // Fighting back, it stays on what is already fighting it whether or not it would have chosen to.
  private async fight(serial: number, going: () => boolean | Promise<boolean>, back = false) {
    if (this.world.entities.get(serial)?.kind !== 'mobile') return false;
    if (!back && this.encounter?.allows(serial) === false) {
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
        if (!back && this.encounter?.allows(serial) === false) return false;
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
      .filter((e) => e.parent === serial && !isDeathRobe(e) && this.worth(e.serial) > 0)
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
  private async buy(step: Extract<Step, { verb: 'buy' }>, going: () => boolean | Promise<boolean>) {
    const world = this.world;
    const here = world.position;
    const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Backpack);
    if (!here || !pack) return false;
    const people = [...world.entities.values()]
      .filter((e) => e.kind === 'mobile' && e.serial !== world.serial && e.position && away(here, e.position) <= 18)
      .sort((a, b) => away(here, a.position ?? here) - away(here, b.position ?? here));
    for (const vendor of people) {
      if (!(await going())) return false;
      if (
        vendor.position &&
        away(world.position ?? here, vendor.position) > 2 &&
        !(await this.walk({ ...vendor.position, range: 2 }, going))
      )
        continue;
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
      if (!offer || (step.training && offer.price > step.price)) continue;
      const amount = Math.min(step.amount ?? 1, world.entities.get(offer.serial)?.amount ?? 1);
      if (amount < 1 || !(await going())) return false;
      await this.session.purchaseItem(vendor.serial, offer.serial, pack.serial, amount, offer.price * amount);
      if (step.training) this.notice?.('care', { action: 'training-spent', amount: offer.price * amount });
      return true;
    }
    return false;
  }

  // Out of its bank box into its pack once the banker opens it.
  private async withdraw(items: number[], going: () => boolean | Promise<boolean>, amounts?: Record<number, number>) {
    const world = this.world;
    const box = () => [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Bank);
    const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Backpack);
    if (!pack || !(await this.until(() => !!box(), 3000))) return false;
    for (const serial of items) {
      if (!(await going())) return false;
      // The box's contents follow its opening; what is not among them is gone (things.ts `listed`).
      await this.until(() => world.entities.has(serial), 1000);
      let item = world.entities.get(serial);
      if (!item) return this.gone(serial, 'bank');
      if (world.status && !item.properties) {
        await this.session.inspectProperties(serial);
        item = world.entities.get(serial);
      }
      if (!item) return false;
      const total = item.amount ?? 1;
      let amount = Math.min(total, amounts?.[serial] ?? total);
      if (world.status) {
        const weight = facts(item.properties ?? []).weight;
        if (weight === undefined) return false;
        const unit = weight / total;
        if (unit > 0)
          amount = Math.min(
            amount,
            Math.max(0, Math.floor((world.status.maxWeight - world.status.weight + 1e-9) / unit))
          );
      }
      if (amount <= 0 || (amounts?.[serial] !== undefined && amount < (amounts[serial] as number))) return false;
      const bank = box();
      if (!bank) return false;
      await this.session.moveItem(serial, pack.serial, amount < total ? amount : undefined);
      if (!(await this.until(() => world.entities.get(serial)?.parent === pack.serial, 2000))) return false;
      if (this.session.refreshStatus) await this.session.refreshStatus();
      if (this.session.inspectProperties) await this.session.inspectProperties(bank.serial, true);
      if (world.status && world.status.weight > world.status.maxWeight) {
        await this.session.moveItem(serial, bank.serial);
        return false;
      }
    }
    return true;
  }

  // Into its bank box once the banker opens it.
  private async deposit(items: number[], going: () => boolean | Promise<boolean>, amounts?: Record<number, number>) {
    const world = this.world;
    const box = () => [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Bank);
    if (!(await this.until(() => !!box(), 3000))) return false;
    for (const serial of items) {
      const bank = box();
      if (!(await going()) || !bank) return false;
      if (!world.entities.has(serial)) return this.gone(serial, 'pack');
      const item = world.entities.get(serial);
      if (!item || isDeathRobe(item)) return false;
      if (this.session.inspectProperties) await this.session.inspectProperties(bank.serial, true);
      const capacity = bankCount(world.entities.values(), world.entities.get(bank.serial) ?? bank);
      const added = 1 + descendants(world.entities.values(), serial).length;
      if (capacity.count + added > capacity.max) return false;
      await this.session.moveItem(serial, bank.serial, amounts?.[serial]);
      if (
        !(await this.until(
          () => !world.entities.has(serial) || world.entities.get(serial)?.parent === bank.serial,
          2000
        ))
      )
        return false;
      if (this.session.inspectProperties) await this.session.inspectProperties(bank.serial, true);
    }
    return true;
  }

  // A vendor's buying list from its context menu, and every offered stack of what it meant to sell.
  private async sell(vendor: number, items: number[], going: () => boolean | Promise<boolean> = () => true) {
    if (!items.length) return false;
    const remaining = new Set(items);
    while (remaining.size) {
      if (!(await going())) return false;
      const entry = (await this.session.context(vendor)).find((e) => e.cliloc === Actions.sell && !(e.flags & 1));
      if (!entry) return false;
      this.world.sellOffers.delete(vendor);
      this.session.selectContext(vendor, entry.index);
      if (!(await this.until(() => this.world.sellOffers.has(vendor), 2500))) return false;
      const offers = (this.world.sellOffers.get(vendor) ?? [])
        .filter(
          (o) =>
            remaining.has(o.serial) && o.price > 0 && !isDeathRobe(this.world.entities.get(o.serial) ?? { graphic: 0 })
        )
        .slice(0, 99);
      if (!offers.length) return false;
      await this.session.sell(
        vendor,
        offers.map((o) => ({ serial: o.serial, amount: o.amount }))
      );
      for (const offer of offers) remaining.delete(offer.serial);
    }
    return true;
  }

  // Animal Taming on a creature: the skill's cursor answered with it, then the shard's word at the
  // end of the 9 to 12 seconds a try takes (ServUO AnimalTaming): accepted as master, or not.
  private async tame(serial: number, going: () => boolean | Promise<boolean>) {
    if (!this.world.entities.has(serial)) return false;
    const heard = this.world.heard;
    this.session.useSkill(skillId('AnimalTaming'));
    if (!(await this.until(() => !!this.world.target, 3000))) return false;
    this.session.target({ serial, x: 0, y: 0, z: 0, graphic: 0 });
    for (const end = Date.now() + 20_000; Date.now() < end; await Bun.sleep(250)) {
      const said = this.world.journalSince(heard).map((e) => e.cliloc);
      if (said.some((cliloc) => cliloc !== undefined && tamed.has(cliloc))) return true;
      if (said.some((cliloc) => cliloc !== undefined && untamed.has(cliloc))) return false;
      if (!(await going())) return false;
    }
    return false;
  }

  private gone(serial: number, where: 'pack' | 'bank') {
    this.missing?.(serial, where);
    return false;
  }

  private async until(done: () => boolean, ms: number) {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (done()) return true;
    return done();
  }
}
