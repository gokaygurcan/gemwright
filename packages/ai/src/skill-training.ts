import { HUMAN_ELF_BODIES } from '@gemwright/common/bodies';
import { skillId } from '@gemwright/common/skills';

import type { CharacterArchetype } from './archetypes';
import { type CraftContext, type CraftSkill, carpentry, tinkering, trainCraft } from './craft-training';
import { serviceLocations } from './locations';
import { trainMagery } from './magery';
import { buyAtMarket, goods } from './market';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { buyFrom } from './vendor-trade';

const TOO_SOON = 500118; // You must wait a few moments to use another skill.
// Pickaxes are BaseAxe weapons in ServUO, so a miner always carries a valid Arms Lore target.
const ARMS = new Set([0x0e85, 0x0e86, 0x0f43, 0x0f44, 0x0f49, 0x0f4a, 0x13b9, 0x13ba, 0x0f51, 0x0f52, 0x1b72, 0x1b73]);
const HUMANS = HUMAN_ELF_BODIES;
const HORSES = new Set([0xc8, 0xe2, 0xe4, 0xcc]);

interface PracticeContext {
  session: PlayerSession;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  items: () => Entity[];
  until: number;
  // Ends practice early, e.g. a fighter seeing a hostile approach.
  interrupt?: () => boolean;
}

// A skill used on a loop like a player's macro: the server's NextSkillTime (`delay`, from the
// skill's OnUse) plus a small human margin. `target` picks an object, 'ground' targets the
// character's own tile, 'none' needs no cursor. `refused` replies drop that target.
interface Practice {
  skill: string;
  delay: number;
  // Skill to use first each round (Stealth only works while hidden).
  before?: string;
  target: ((ctx: PracticeContext) => Entity[]) | 'ground' | 'none';
  refused?: number[];
}

// Nearby mobiles a lore skill can study: no vendors (invulnerable) and never the character itself,
// which ServUO answers with "You know yourself quite well enough already" (500324) and no gain.
const others = (ctx: PracticeContext, bodies?: Set<number>) => {
  const { world } = ctx.session;
  const here = world.position;
  return [...world.entities.values()].filter(
    (m) =>
      m.kind === 'mobile' &&
      m.serial !== world.serial &&
      m.notoriety !== 7 &&
      (!bodies || bodies.has(m.graphic)) &&
      !!m.position &&
      !!here &&
      Math.max(Math.abs(m.position.x - here.x), Math.abs(m.position.y - here.y)) <= 8
  );
};
const studied = (ctx: PracticeContext) => [...others(ctx, HORSES), ...others(ctx, HUMANS)];

const practices: Record<string, Practice> = {
  ArmsLore: {
    skill: 'ArmsLore',
    delay: 1000,
    target: (ctx) => ctx.items().filter((i) => ARMS.has(i.graphic)),
    refused: [500352]
  },
  Anatomy: { skill: 'Anatomy', delay: 1000, target: studied, refused: [500324, 500326] },
  EvalInt: { skill: 'EvalInt', delay: 1000, target: studied, refused: [500324, 500326] },
  AnimalLore: { skill: 'AnimalLore', delay: 1000, target: (ctx) => others(ctx, HORSES) },
  Hiding: { skill: 'Hiding', delay: 10000, target: 'none' },
  DetectHidden: { skill: 'DetectHidden', delay: 10000, target: 'ground' },
  Stealth: { skill: 'Stealth', delay: 10000, target: 'none', before: 'Hiding' }
};

export async function practiseSkill(ctx: PracticeContext, practice: Practice) {
  const { session, check, phase, log } = ctx;
  const id = skillId(practice.skill);
  const refused = new Set<number>();
  let uses = 0;
  phase('training', `Practising ${practice.skill}`);
  while (Date.now() < ctx.until && !ctx.interrupt?.()) {
    check();
    if ((session.world.skills.get(id)?.base ?? 0) >= 100) break;
    const target =
      typeof practice.target === 'function' ? practice.target(ctx).find((e) => !refused.has(e.serial)) : undefined;
    if (typeof practice.target === 'function' && !target) break;
    const startedAt = Date.now();
    const last = session.world.journal.at(-1);
    const feedback = () =>
      (last ? session.world.journal.slice(session.world.journal.indexOf(last) + 1) : session.world.journal).find(
        (entry) => entry.cliloc !== undefined
      );
    if (practice.before) {
      session.useSkill(skillId(practice.before));
      await Bun.sleep(1500);
    }
    session.useSkill(id);
    try {
      if (practice.target === 'none') {
        await session.waitFor(() => feedback() !== undefined, `${practice.skill} result`, 3000).catch(() => {});
        if (feedback()?.cliloc !== TOO_SOON) uses++;
      } else {
        await session.waitFor(
          () => session.world.target !== null || feedback()?.cliloc === TOO_SOON,
          'skill cursor',
          3000
        );
        const here = session.world.position;
        if (session.world.target && target) {
          session.target({ serial: target.serial, x: 0, y: 0, z: 0, graphic: target.graphic });
          uses++;
        } else if (session.world.target && here) {
          session.target({ serial: 0, x: here.x, y: here.y, z: here.z, graphic: 0 });
          uses++;
        }
        await Bun.sleep(400);
        const reply = feedback()?.cliloc;
        if (target && reply !== undefined && practice.refused?.includes(reply)) refused.add(target.serial);
      }
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      if (session.world.target) session.target(null);
    }
    await Bun.sleep(Math.max(0, practice.delay + 150 + Math.random() * 450 - (Date.now() - startedAt)));
  }
  log(`Practised ${practice.skill} ${uses} times`);
  return uses;
}

type TrainingContext = PracticeContext & {
  archetype?: CharacterArchetype;
  // Vendor access for skills that need bought tools, reagents or a spellbook; `refills` brings
  // crafting material into the pack (a bank withdrawal of iron, for example).
  shop?: CraftContext & {
    backpack: () => number;
    refills?: Partial<Record<string, (backpack: number, least: number) => Promise<boolean>>>;
  };
};

// Iron for Tinkering, when the resident brings no refill of its own (miners withdraw theirs): the
// Minoc market when already near it (market.ts), else the tinker's 16-ingot stock.
const ironRefill =
  (shop: NonNullable<TrainingContext['shop']>) =>
  async (_backpack: number, least: number): Promise<boolean> => {
    const minoc = serviceLocations('minoc', 'banker')[0];
    const want = Math.max(least * 3, 30);
    if (minoc && distance(shop.position(), minoc) < 300 && (await buyAtMarket(shop, 'iron ingots', want, 3)) >= least)
      return true;
    return buyFrom(shop, 'tinker', new Map([[goods['iron ingots'].graphic, Math.min(want, 16)]]), 6);
  };

const craftTrainer =
  (craft: CraftSkill) =>
  ({ shop, until }: TrainingContext) =>
    shop
      ? trainCraft(
          {
            ...shop,
            refill: shop.refills?.[craft.skill] ?? (craft.skill === 'Tinkering' ? ironRefill(shop) : undefined)
          },
          craft,
          shop.backpack(),
          until
        )
      : Promise.resolve(0);

// Supporting skills a resident can practise; shop-dependent ones only run with vendor access.
const trainers: Record<string, (ctx: TrainingContext) => Promise<number>> = {
  ...Object.fromEntries(
    Object.entries(practices).map(([key, practice]) => [key, (ctx) => practiseSkill(ctx, practice)])
  ),
  Tinkering: craftTrainer(tinkering),
  Carpentry: craftTrainer(carpentry),
  Magery: ({ shop, until }) => (shop ? trainMagery(shop, until) : Promise.resolve(0))
};

// The archetype's supporting skills that can still be practised: a trainer exists and the skill is
// below its cap and not locked (a maxed skill, 100.0 on the pinned shard, is never practised again).
export function trainable(session: PlayerSession, archetype?: CharacterArchetype): string[] {
  return (archetype?.supportingSkills ?? ['Arms Lore']).filter((name) => {
    const skill = session.world.skills.get(skillId(name));
    return !!trainers[name.replaceAll(' ', '')] && (skill?.base ?? 0) < (skill?.cap ?? 100) && skill?.lock !== 2;
  });
}

// Tries the archetype's trainable supporting skills in random order until one practises.
export async function trainSupportingSkill(ctx: TrainingContext) {
  const options = trainable(ctx.session, ctx.archetype)
    .flatMap((name) => {
      const trainer = trainers[name.replaceAll(' ', '')];
      return trainer ? [trainer] : [];
    })
    .sort(() => Math.random() - 0.5);
  for (const trainer of options) {
    if (Date.now() >= ctx.until) break;
    const done = await trainer(ctx);
    if (done > 0) return done;
  }
  return 0;
}
