import { fishingPoles, gold } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { fishingTurn } from './fisher';
import { pickLocation, townAt } from './locations';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import { begForTool } from './subsistence';
import { trainFromNpc } from './training';

// A side trade for a resident whose own work does not pay, as players pick one up: most residents
// use 400-500 of their 700 skill points, so there is room. Fishing first: a pole costs about 15
// gold, it works from 0 skill on any shore near town, and every fisherman buys the catch. With the
// money for it, the resident first pays a fisherman to teach it up to 30 (one gold per 0.1 point);
// a broke one begs for the pole's price and learns by fishing. It fishes while it is broke, and
// for two hours after any three hours in which its funds did not grow, or after a loop, and a
// fighter without the weapon or bandages it cannot afford fishes until it can (`needed`).
const CHECK_MS = 3 * 3_600_000;
const SPELL_MS = 2 * 3_600_000;
const ROOM = 650;
const LESSON_TO = 30;
const avoid = new Set<string>();

const funds = (ctx: ProfessionContext) => ctx.count(gold) + (ctx.checkpoint.funds?.bank ?? 0);
const skill = (ctx: ProfessionContext, name: string) => ctx.session.world.skills.get(skillId(name))?.base ?? 0;

// True when it spent the turn on its side trade.
export async function sideTradeTurn(ctx: ProfessionContext, profession: string, needed = false): Promise<boolean> {
  if (profession === 'fisher') return false;
  const total = [...ctx.session.world.skills.values()].reduce((n, s) => n + (s.base ?? 0), 0);
  if (total >= ROOM && skill(ctx, 'Fishing') < 1 && !needed) return false;
  const now = Date.now();
  ctx.checkpoint.sideTrade ??= { checkAt: now, funds: funds(ctx), until: 0 };
  const state = ctx.checkpoint.sideTrade;
  if (now - state.checkAt >= CHECK_MS) {
    if (funds(ctx) <= state.funds) state.until = now + SPELL_MS;
    state.checkAt = now;
    state.funds = funds(ctx);
    ctx.persist();
  }
  const broke = funds(ctx) < 100;
  if (!broke && !needed && state.until <= now) return false;
  // Only where a fisherman is in walking reach: nobody crosses the land for a side trade.
  const town = townAt(ctx.position(), ctx.city);
  const shop = pickLocation(town, 'fisherman', ctx.position());
  if (!shop || distance(ctx.position(), shop) > 300) return false;
  const local = { ...ctx, city: town };
  if (
    skill(ctx, 'Fishing') < LESSON_TO &&
    funds(ctx) >= 500 &&
    now - (ctx.checkpoint.training?.Fishing ?? 0) > 24 * 3_600_000
  ) {
    ctx.phase('side-trade', `Taking up fishing; paying a fisherman in ${town} for lessons`);
    await ctx.navigate(shop, 4).catch(() => {});
    const nearby = () =>
      [...ctx.session.world.entities.values()].filter(
        (m) => m.kind === 'mobile' && m.position && distance(ctx.position(), m.position) <= 12
      );
    for (const npc of nearby().filter((m) => m.notoriety === 7)) {
      if (await trainFromNpc({ ...local, nearby }, npc, 'Fishing', 350).catch(() => 0)) break;
    }
  }
  const pole = [...ctx.carried(), ...ctx.session.world.childrenOf(ctx.serial)].some((i) => fishingPoles.has(i.graphic));
  if (!pole && funds(ctx) < 20 && !(await begForTool(local, 20))) return false;
  ctx.phase('side-trade', broke ? 'Fishing for a living until money comes in' : 'Fishing on the side');
  await fishingTurn(avoid)(local);
  return true;
}

// For runners without a ProfessionContext (miner, lumberjack): the side trade after a loop, while
// the setback's two hours last (setback.ts). True when it spent the turn on it.
export async function loopSideTrade(
  parts: Omit<ProfessionContext, 'carried' | 'count' | 'progress' | 'practise' | 'persist' | 'template'> & {
    persist: () => void;
    template: ProfessionContext['template'];
  },
  profession: string
): Promise<boolean> {
  if ((parts.checkpoint.sideTrade?.until ?? 0) <= Date.now()) return false;
  const carried = (pack?: number) => parts.session.world.childrenOf(pack ?? parts.backpack());
  const count = (graphic: number) =>
    carried().reduce((n, item) => n + (item.graphic === graphic ? (item.amount ?? 1) : 0), 0);
  return sideTradeTurn({ ...parts, carried, count, progress: {}, practise: async () => 0 }, profession, true);
}
