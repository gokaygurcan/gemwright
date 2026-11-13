import { GHOST_BODIES, HUMAN_ELF_BODIES } from '@gemwright/common/game/bodies';
import { creatures } from '@gemwright/common/game/rules';
import { skillId } from '@gemwright/common/game/skills';
import { gumpButtons, gumpCommands } from '@gemwright/network/gumps';
import { Layer } from '@gemwright/network/layers';
import { Notoriety, Opcode } from '@gemwright/network/opcodes';
import { Stabling } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';

import { facts } from './knowledge';
import type { Step } from './options';
import { screenOf } from './perceive';

type Going = () => boolean | Promise<boolean>;
type Notice = (kind: string, data: object) => void;
const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export class CareHands {
  constructor(
    private readonly session: PlayerSession,
    private readonly notice: Notice,
    private readonly call: (serial: number) => string | undefined
  ) {}
  private get world() {
    return screenOf(this.session);
  }

  private async until(done: () => boolean, ms: number, going: Going) {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (!(await going())) return false;
      if (done()) return true;
      await Bun.sleep(100);
    }
    return done() && (await going());
  }

  async pickup(serial: number, requested: number, going: Going, from?: number) {
    const world = this.world;
    const item = world.entities.get(serial);
    const pack = world.childrenOf(world.serial ?? -1).find((e) => e.layer === Layer.Backpack);
    const here = world.position;
    if (!item || !pack || !here || !(await going())) return false;
    if (
      from === undefined &&
      (item.parent !== undefined ||
        !item.position ||
        away(here, item.position) > 2 ||
        Math.abs(here.z - item.position.z) > 10 ||
        !((item.flags ?? 0) & 32))
    )
      return false;
    if (from !== undefined && item.parent !== from) return false;
    if (!item.properties) await this.session.inspectProperties(serial);
    const updated = world.entities.get(serial);
    if (!updated) return false;
    const total = updated.amount ?? 1;
    const weight = facts(updated.properties ?? []).weight;
    if (world.status && weight === undefined) return false;
    const unit = (weight ?? 0) / total;
    const amount = Math.min(
      requested,
      total,
      unit && world.status ? Math.max(0, Math.floor((world.status.maxWeight - world.status.weight) / unit)) : total
    );
    if (amount <= 0 || !(await going())) return false;
    const before = new Map(world.childrenOf(pack.serial).map((i) => [i.serial, i.amount ?? 1]));
    this.notice('care', { action: 'pickup', key: `pickup ${serial}`, until: Date.now() + 60_000 });
    await this.session.moveItem(serial, pack.serial, amount < total ? amount : undefined);
    return this.until(
      () =>
        world.entities.get(serial)?.parent === pack.serial ||
        world
          .childrenOf(pack.serial)
          .some((i) => i.graphic === updated.graphic && (i.amount ?? 1) > (before.get(i.serial) ?? 0)),
      2000,
      going
    );
  }

  async recover(serial: number | undefined, going: Going) {
    const world = this.world;
    const here = world.position;
    const corpse =
      serial === undefined
        ? [...world.entities.values()].find(
            (e) => this.call(e.serial) === 'my Corpse' && e.position && here && away(here, e.position) <= 2
          )
        : world.entities.get(serial);
    if (!corpse?.position || !here || away(here, corpse.position) > 2 || this.call(corpse.serial) !== 'my Corpse')
      return false;
    const before = new Set(world.childrenOf(world.serial ?? -1).map((i) => i.serial));
    const pack = world.childrenOf(world.serial ?? -1).find((i) => i.layer === Layer.Backpack);
    if (!pack) return false;
    for (const item of world.childrenOf(pack.serial)) before.add(item.serial);
    const opened = world.received.get(Opcode.containerContents) ?? 0;
    this.session.use(corpse.serial);
    const changed = () =>
      [...world.entities.values()].some(
        (i) => (i.parent === world.serial || i.parent === pack.serial) && !before.has(i.serial)
      );
    if (
      !(await this.until(
        () =>
          changed() ||
          (world.received.get(Opcode.containerContents) ?? 0) > opened ||
          world.childrenOf(corpse.serial).length > 0,
        3000,
        going
      ))
    )
      return false;
    // Corpse.Open self-loots on AOS; anything left is still ours, regardless of sale value.
    for (const item of world.childrenOf(corpse.serial)) {
      if (!(await this.pickup(item.serial, item.amount ?? 1, going, corpse.serial))) return false;
    }
    this.notice('care', { action: 'corpse', serial: corpse.serial });
    return true;
  }

  async help(going: Going) {
    const world = this.world;
    const from = world.position && { ...world.position };
    if (!from || world.target || !(await going())) return false;
    const old = new Set(world.gumps.values());
    this.notice('care', { action: 'help-request' });
    this.session.requestHelp();
    const help = () => [...world.gumps.values()].find((g) => !old.has(g) && gumpButtons(g.layout).includes(2));
    if (!(await this.until(() => !!help(), 5000, going))) return false;
    const h = help();
    if (!h) return false;
    this.session.replyGump(h.serial, h.id, 2, []);
    const menu = () =>
      [...world.gumps.values()].find((g) =>
        gumpCommands(g.layout).some((c) => c[0]?.startsWith('xmfhtml') && Number(c[5]) === 1011027)
      );
    if (!(await this.until(() => !!menu(), 5000, going))) return false;
    const town = menu();
    if (!town || !gumpButtons(town.layout).includes(1)) return false;
    this.session.replyGump(town.serial, town.id, 1, []);
    this.notice('care', { action: 'help-used' });
    const moved = await this.until(() => !!world.position && away(from, world.position) > 30, 130_000, going);
    if (moved) await this.session.resyncPosition();
    return moved;
  }

  guards(serial: number) {
    const world = this.world;
    const self = world.entities.get(world.serial ?? -1);
    const offender = world.entities.get(serial);
    if (
      !self ||
      GHOST_BODIES.has(self.graphic) ||
      self.notoriety === Notoriety.criminal ||
      self.notoriety === Notoriety.murderer ||
      !offender?.position ||
      !world.position ||
      !HUMAN_ELF_BODIES.has(offender.graphic) ||
      ![Notoriety.criminal, Notoriety.murderer].includes(offender.notoriety ?? 0) ||
      away(world.position, offender.position) > 12
    )
      return false;
    this.session.say('guards');
    this.notice('care', { action: 'guards', key: `guards ${serial}`, until: Date.now() + 60_000 });
    return true;
  }

  async claim(going: Going) {
    const world = this.world;
    const heard = new Set(world.journal);
    const before = new Set(world.entities.keys());
    this.notice('care', { action: 'claim', answer: 'asked' });
    this.session.say('claim');
    const reply = () =>
      world.journal.find(
        (e) =>
          !heard.has(e) && [Stabling.claimed, Stabling.noneStabled, Stabling.tooManyFollowers].includes(e.cliloc ?? 0)
      )?.cliloc;
    if (!(await this.until(() => reply() !== undefined, 4000, going))) return false;
    const answer = reply() === Stabling.claimed ? 'claimed' : reply() === Stabling.noneStabled ? 'none' : 'too-many';
    const mounts = new Set(creatures.filter((c) => c.mount).flatMap((c) => c.bodies));
    const claimed = () =>
      [...world.entities.values()].filter(
        (e) =>
          !before.has(e.serial) &&
          e.kind === 'mobile' &&
          mounts.has(e.graphic) &&
          e.position &&
          world.position &&
          away(e.position, world.position) <= 3
      );
    const mount = () => claimed()[0];
    if (answer === 'claimed') await this.until(() => !!mount(), 3000, going);
    this.notice('care', { action: 'claim', answer, ...(mount() ? { serial: mount()?.serial } : {}) });
    // A bare claim brings out every stabled pet the follower slots allow (ServUO AnimalTrainer.Claim);
    // it rides one, and each other goes back to its stall as a player stables it: "stable", then
    // the trainer's cursor on the pet (BeginStable, StableTarget).
    if (answer === 'claimed') await this.until(() => false, 1000, going);
    for (const extra of claimed().slice(1)) await this.stable(extra.serial, going);
    return answer === 'claimed';
  }

  private async stable(serial: number, going: Going) {
    const world = this.world;
    const pet = world.entities.get(serial);
    if (!pet?.position || world.target) return false;
    const heard = new Set(world.journal);
    this.session.say('stable');
    if (!(await this.until(() => !!world.target, 4000, going))) return false;
    const at = world.entities.get(serial)?.position ?? pet.position;
    this.session.target({ serial, x: at.x, y: at.y, z: at.z ?? 0, graphic: pet.graphic });
    const reply = () => world.journal.find((e) => !heard.has(e) && e.cliloc === Stabling.stabled);
    const stabled = await this.until(() => !!reply() || !world.entities.has(serial), 4000, going);
    this.notice('care', { action: 'stable', serial, stabled });
    return stabled;
  }

  async practice(step: Extract<Step, { verb: 'practice' }>, going: Going) {
    const world = this.world;
    if (world.target || !(await going())) return false;
    let heard = new Set(world.journal);
    const began = Date.now();
    this.notice('care', { action: 'practice', key: `practice ${step.skill}`, until: began + step.delay });
    const mana = world.status?.mana;
    const body = world.entities.get(world.serial ?? -1)?.graphic;
    this.session.useSkill(step.spell ?? skillId(step.skill), step.spell !== undefined);
    if (step.serial !== undefined || step.ground) {
      if (!(await this.until(() => !!world.target, 3000, going))) return false;
      const aim = step.serial === undefined ? world.position : world.entities.get(step.serial);
      if (!aim) {
        this.session.target(null);
        return false;
      }
      const at = step.serial === undefined ? world.position : world.entities.get(step.serial)?.position;
      heard = new Set(world.journal);
      this.session.target({
        serial: step.serial ?? 0,
        x: at?.x ?? 0,
        y: at?.y ?? 0,
        z: at?.z ?? 0,
        graphic: step.serial === undefined ? 0 : (world.entities.get(step.serial)?.graphic ?? 0)
      });
    }
    const result = () => world.journal.find((e) => !heard.has(e) && ![500349, 500321].includes(e.cliloc ?? 0));
    const changed = () =>
      step.spell !== undefined &&
      ((mana !== undefined && (world.status?.mana ?? mana) < mana) ||
        world.entities.get(world.serial ?? -1)?.graphic !== body);
    if (!(await this.until(() => !!result() || changed(), step.spell !== undefined ? 5000 : 3000, going))) return false;
    if (step.spell !== undefined && result()?.cliloc === 500015) this.notice('spell-missing', { spell: step.spell });
    const refused = [500118, 500352, 500324, 500326, 500015, 502625, 502630].includes(result()?.cliloc ?? 0);
    if (refused) return false;
    if (step.spell !== undefined) this.notice('care', { action: 'spell-known', spell: step.spell });
    return this.until(() => Date.now() >= began + step.delay, step.delay + 100, going);
  }
}
