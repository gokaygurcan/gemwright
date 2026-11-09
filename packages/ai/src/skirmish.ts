import { HUMAN_ELF_BODIES } from '@gemwright/common/game/bodies';
import { gold } from '@gemwright/common/game/items';
import { hostileNotoriety } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { DangerInterrupt, urgentAction } from './action-purpose';
import { withinReach } from './areas';
import { transfer } from './bank-box';
import { Blocked } from './blocked';
import { grounds } from './cemeteries';
import { forecastFight } from './combat-forecast';
import { type Death, openCorpse } from './corpse-open';
import { escapeDanger } from './danger-response';
import { valuable } from './fighter-context';
import { monsters } from './monster-reference';
import { distance } from './navigation';
import { canBeat, harmless, selfState } from './self-state';

// The one answer every resident gives to being attacked, whatever its trade: who is hitting me,
// can I finish it, then fight or run — and take what it dropped. The fighter has its own deeper
// version; everyone else uses this. It is also how a resident with nothing scraps for a start:
// weak creatures outside town, bare-handed if it must, back to town when hurt.
export interface SkirmishContext {
  session: PlayerSession;
  serial: number;
  position: () => { x: number; y: number; z: number };
  status: () => { hits: number; maxHits: number };
  navigate: (point: { x: number; y: number }, range: number) => Promise<unknown>;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  backpack: () => number;
}

const scrapping = new WeakMap<PlayerSession, number>();

// The share of its maximum health a fight costs, with ServUO's hit chance ((skill + 20) over twice
// the defender's + 20) and the weapon in hand or fists. Unknown creatures count as costly.
function fightShare(session: PlayerSession, monster: (typeof monsters)[number] | undefined) {
  if (!monster) return Infinity;
  return forecastFight(
    session,
    { serial: -1, kind: 'mobile', graphic: monster.bodies[0] ?? 0, name: monster.name ?? undefined },
    { stats: monster }
  ).predictedLoss;
}

export const canTake = (ctx: SkirmishContext, mobile: Entity, _engaged: boolean) =>
  canBeat(ctx.session, selfState(ctx.session, false), mobile);

export function attackerOf(ctx: SkirmishContext) {
  const { session } = ctx;
  return [...session.world.entities.values()].find((mobile) => {
    const swing = session.world.swings.get(mobile.serial);
    return (
      mobile.kind === 'mobile' &&
      swing?.target === ctx.serial &&
      Date.now() - swing.at < 3000 &&
      !session.world.deaths.has(mobile.serial)
    );
  });
}

// Danger interrupted the work: fight what attacks (or, while scrapping, what it came for) when it
// can win, otherwise run toward `refuge`.
export async function answerDanger(ctx: SkirmishContext, refuge: { x: number; y: number } | undefined) {
  const attacker = attackerOf(ctx);
  const prey = attacker ?? ((scrapping.get(ctx.session) ?? 0) > Date.now() ? beatableNear(ctx, 10)[0] : undefined);
  if (prey && canTake(ctx, prey, !!attacker) && (await skirmish(ctx, prey))) return;
  await escapeDanger(ctx, refuge);
}

// One fight to its end. True when the opponent died; false when it ran or lost track of it.
export async function skirmish(ctx: SkirmishContext, opponent: Entity): Promise<boolean> {
  const { session } = ctx;
  const won = await urgentAction(session, 'combat', async () => {
    ctx.phase('skirmish', `Fighting ${opponent.name ?? 'a creature'}`);
    session.setWarMode(true);
    await session.attack(opponent.serial);
    while (!session.world.deaths.has(opponent.serial)) {
      try {
        ctx.check();
      } catch (error) {
        if (!(error instanceof DangerInterrupt)) throw error;
      }
      const target = session.world.entities.get(opponent.serial);
      if (!target?.position || distance(ctx.position(), target.position) > 14) return false;
      if (!canTake(ctx, target, true)) return false;
      if (session.world.combatant !== opponent.serial) await session.attack(opponent.serial);
      if (distance(ctx.position(), target.position) > 1)
        await ctx.navigate(target.position, 1).catch((error) => {
          if (!(error instanceof Blocked)) throw error;
        });
      await Bun.sleep(500);
    }
    return true;
  }).finally(() => session.setWarMode(false));
  if (!won) {
    ctx.log(`Broke off the fight with ${opponent.name ?? 'a creature'} at ${ctx.status().hits} health`);
    return false;
  }
  await loot(ctx, session.world.deaths.get(opponent.serial));
  return true;
}

async function loot(ctx: SkirmishContext, death: Death | undefined) {
  ctx.phase('looting', 'Taking what it dropped');
  const opened = await openCorpse(ctx, death);
  if ('why' in opened) return ctx.log(`Loot: left the corpse (${opened.why})`);
  const taken = await transfer(
    ctx,
    opened.items.filter((item) => item.graphic === gold || valuable(item.graphic)),
    ctx.backpack()
  );
  for (const refusal of taken.refused) ctx.log(`Loot refused: ${refusal.reason}`);
}

// What it could beat in view: any attackable creature, passive ones too (a rabbit never comes to it).
const beatableNear = (ctx: SkirmishContext, radius: number) => {
  const here = ctx.position();
  return [...ctx.session.world.entities.values()]
    .filter(
      (m) =>
        m.kind === 'mobile' &&
        m.serial !== ctx.serial &&
        !!m.position &&
        distance(here, m.position) <= radius &&
        hostileNotoriety.includes(m.notoriety ?? 0) &&
        !HUMAN_ELF_BODIES.has(m.graphic) &&
        // A creature that never starts a fight (a cow, a boar) is no prey: nothing to win, only a kill.
        !harmless(m) &&
        !ctx.session.world.deaths.has(m.serial) &&
        canTake(ctx, m, false)
    )
    .sort((a, b) => distance(here, a.position ?? here) - distance(here, b.position ?? here));
};

// A resident with no way to earn goes out to the nearest ground with creatures it can beat — mixed
// in with others, as they spawn — and picks those out. Fights that come to it go through
// answerDanger. True when it got to fight.
export async function scrapTurn(ctx: SkirmishContext): Promise<boolean> {
  const { session } = ctx;
  const here = ctx.position();
  const beatable = (creatures: Record<string, number>) => {
    const counts = Object.entries(creatures);
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    const weak = counts.reduce(
      (sum, [type, n]) =>
        sum +
        n /
          (1 +
            fightShare(
              session,
              monsters.find((monster) => monster.type === type)
            )),
      0
    );
    return weak / Math.max(1, total);
  };
  const ground = grounds
    .filter((g) => g.creatures && beatable(g.creatures) > 0 && withinReach(here, g.center))
    .map((g) => ({ g, cost: distance(here, g.center) * (2 - beatable(g.creatures ?? {})) }))
    .sort((a, b) => a.cost - b.cost)[0]?.g;
  if (!ground) {
    ctx.log('Scrapping: no ground of creatures it can beat within reach');
    return false;
  }
  scrapping.set(session, Date.now() + 10 * 60_000);
  ctx.phase('scrapping', `Nothing to earn with; picking out weak creatures at the ${ground.name} for a start`);
  if (distance(here, ground.center) > 12) await ctx.navigate(ground.center, 6);
  const prey = beatableNear(ctx, 18)[0];
  return !!prey && (await skirmish(ctx, prey));
}
