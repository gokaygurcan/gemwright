import { spellbook } from '@gemwright/common/game/items';
import { gumpCommands } from '@gemwright/network/gumps';
import { Layer } from '@gemwright/network/layers';
import { ShardCraft, ShardMessage } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';

import { buttonFor } from '../v1/gump-flow';
import { descendants } from './bank-space';
import type { Step } from './options';
import { screenOf } from './perceive';

type Going = () => boolean | Promise<boolean>;
const made = [1044154, 1044155, 1044156, 502785, 500279];
const failed = [1044043, 1044157, 500287];
const stopped = [ShardCraft.toolWornOut, ShardCraft.stationMessage, 1044037, 1044153, 1042404];

export class TrainingHands {
  constructor(
    private readonly session: PlayerSession,
    private readonly notice: (kind: string, data: object) => void
  ) {}
  private get world() {
    return screenOf(this.session);
  }
  private carried() {
    const pack = [...this.world.entities.values()].find(
      (i) => i.parent === this.world.serial && i.layer === Layer.Backpack
    );
    return [
      ...(pack ? descendants(this.world.entities.values(), pack.serial) : []),
      ...this.world.childrenOf(this.world.serial ?? -1)
    ];
  }
  private async until(done: () => boolean, ms: number, going: Going) {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (!(await going())) return false;
      if (done()) return true;
      await Bun.sleep(100);
    }
    return done() && (await going());
  }

  async learn(step: Extract<Step, { verb: 'learn-spell' }>, going: Going) {
    const world = this.world;
    if (world.target || !(await going())) return false;
    const book = this.carried().find((i) => i.graphic === spellbook);
    if (!book) return false;
    const before = new Set(world.journal);
    if (step.probe) {
      this.session.useSkill(step.spell, true);
      const reply = () =>
        world.journal.find(
          (e) => !before.has(e) && [ShardMessage.noSuchSpell, 502625, 502630, 502632].includes(e.cliloc ?? 0)
        )?.cliloc;
      if (!(await this.until(() => !!world.target || reply() !== undefined, 5000, going))) return false;
      if (reply() === ShardMessage.noSuchSpell) {
        this.notice('spell-missing', { spell: step.spell });
        return false;
      }
      if (world.target) this.session.target(null);
    } else {
      const scroll = this.carried().find((i) => i.graphic === step.scroll);
      if (!scroll) return false;
      const amount = scroll.amount ?? 1;
      await this.session.moveItem(scroll.serial, book.serial, amount > 1 ? 1 : undefined);
      if (
        !(await this.until(
          () => !world.entities.has(scroll.serial) || (world.entities.get(scroll.serial)?.amount ?? amount) < amount,
          3000,
          going
        ))
      )
        return false;
    }
    this.notice('care', { action: 'spell-known', spell: step.spell });
    return true;
  }

  async craft(step: Extract<Step, { verb: 'craft' }>, going: Going) {
    const world = this.world;
    if (world.target || !(await going())) return false;
    const tool = this.carried().find((i) => step.tools.includes(i.graphic));
    if (!tool) return false;
    const seen = new Set(world.gumps.values());
    const menu = () =>
      [...world.gumps.values()]
        .reverse()
        .find(
          (g) =>
            !seen.has(g) &&
            (buttonFor(g.layout, step.group) !== undefined || buttonFor(g.layout, step.label) !== undefined)
        );
    this.session.use(tool.serial);
    if (!(await this.until(() => !!menu(), 4000, going))) return false;
    let gump = menu();
    if (!gump) return false;
    if (buttonFor(gump.layout, step.label) === undefined) {
      const group = buttonFor(gump.layout, step.group);
      if (group === undefined || !(await going())) return false;
      seen.add(gump);
      this.session.replyGump(gump.serial, gump.id, group, []);
      if (!(await this.until(() => !!menu() && buttonFor(menu()?.layout ?? '', step.label) !== undefined, 4000, going)))
        return false;
      gump = menu();
    }
    const button = gump && buttonFor(gump.layout, step.label);
    if (!gump || button === undefined || !(await going())) return false;
    const before = new Set(world.journal);
    const old = new Set(world.gumps.values());
    const known = [...made, ...failed, ...stopped];
    const reply = () =>
      world.journal.find((e) => !before.has(e) && known.includes(e.cliloc ?? 0))?.cliloc ??
      [...world.gumps.values()]
        .filter((g) => !old.has(g))
        .flatMap((g) =>
          gumpCommands(g.layout)
            .filter((c) => c[0]?.startsWith('xmfhtml') && c[1] === '170' && c[2] === '295')
            .map((c) => Number(c[5]))
        )
        .find((id) => known.includes(id));
    this.session.replyGump(gump.serial, gump.id, button, []);
    if (!(await this.until(() => reply() !== undefined, 8000, going))) return false;
    if (reply() === 1042404 && step.spell !== undefined) this.notice('spell-missing', { spell: step.spell });
    return !stopped.includes(reply() ?? 0);
  }
}
