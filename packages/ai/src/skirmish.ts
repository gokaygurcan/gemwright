import { HUMAN_ELF_BODIES } from '@gemwright/common/game/bodies';
import { gold } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import { hostileNotoriety } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { DangerInterrupt, urgentAction } from './action-purpose';
import { transfer } from './bank-box';
import { Blocked } from './blocked';
import { grounds } from './cemeteries';
import { type Death, openCorpse } from './corpse-open';
import { escapeDanger } from './danger-response';
import { valuable } from './fighter-context';
import { monsters } from './monster-reference';
import { distance } from './navigation';

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

const RETREAT_AT = 0.25;
const scrapping = new WeakMap<PlayerSession, number>();

const statsOf = (mobile: Entity) =>
  monsters.find((m) => m.bodies.includes(mobile.graphic) && (m.name ?? '') === (mobile.name ?? '').toLowerCase()) ??
  monsters.find((m) => m.bodies.includes(mobile.graphic));

// The share of its maximum health a fight costs, with ServUO's hit chance ((skill + 20) over twice
// the defender's + 20) and the weapon in hand or fists. Unknown creatures count as costly.
function fightShare(session: PlayerSession, monster: (typeof monsters)[number] | undefined) {
  if (!monster?.hits || !monster.damage) return 1;
  const skill = (name: string) => session.world.skills.get(skillId(name))?.value ?? 0;
  const held = session.world
    .childrenOf(session.world.serial ?? -1)
    .some((item) => item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded);
  const own = Math.max(...['Swordsmanship', 'Mace Fighting', 'Fencing', 'Wrestling'].map(skill));
  const theirs = monster.wrestling ?? 50;
  const chance = (a: number, d: number) => Math.min(1, Math.max(0.02, (a + 20) / (2 * (d + 20))));
  const str = session.world.status?.strength ?? 50;
  const perSwing = (held ? 8 : 2.5) + skill('Tactics') / 10 + str / 40;
  const hits = ((monster.hits[0] ?? 0) + (monster.hits[1] ?? 0)) / 2;
  const damage = ((monster.damage[0] ?? 0) + (monster.damage[1] ?? 0)) / 2;
  const taken = (hits / perSwing / chance(own, theirs)) * chance(theirs, own) * damage;
  return taken / Math.max(1, session.world.status?.maxHits ?? 1);
}

const health = (ctx: SkirmishContext) => ctx.status().hits / Math.max(1, ctx.status().maxHits);

// Already on it, a fight is worth finishing while health outlasts the cost; a new one needs room
// to spare.
export const canTake = (ctx: SkirmishContext, mobile: Entity, engaged: boolean) =>
  fightShare(ctx.session, statsOf(mobile)) < health(ctx) - (engaged ? RETREAT_AT : 0.4);

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
      if (health(ctx) < RETREAT_AT) return false;
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
  if (health(ctx) < 0.8) return false;
  const here = ctx.position();
  const beatable = (creatures: Record<string, number>) => {
    const counts = Object.entries(creatures);
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    const weak = counts
      .filter(
        ([type]) =>
          fightShare(
            session,
            monsters.find((m) => m.type === type)
          ) < 0.4
      )
      .reduce((sum, [, n]) => sum + n, 0);
    return weak / Math.max(1, total);
  };
  const ground = grounds
    .filter((g) => g.creatures && beatable(g.creatures) > 0 && distance(here, g.center) < 300)
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
