import { HORSE_BODIES, HUMAN_ELF_BODIES } from '@gemwright/common/game/bodies';
import { axeWeapons } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Notoriety } from '@gemwright/network/opcodes';
import { ShardMessage } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { checkedDelay } from './action-purpose';
import type { CharacterArchetype } from './archetypes';
import { supportingOf } from './archetypes';
import { type CraftContext, type CraftSkill, carpentry, tinkering, trainCraft } from './craft-training';
import { trainMagery } from './magery';
import { goods } from './market';
import { practiseInscription, practiseNecromancy } from './spell-practice';
import { onItem, onTile, useOn } from './target-action';
import { buyFrom } from './vendor-trade';

// Pickaxes are BaseAxe weapons in ServUO, so a miner always carries a valid Arms Lore target.

export interface PracticeContext {
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
      m.notoriety !== Notoriety.invulnerable &&
      (!bodies || bodies.has(m.graphic)) &&
      !!m.position &&
      !!here &&
      Math.max(Math.abs(m.position.x - here.x), Math.abs(m.position.y - here.y)) <= 8
  );
};
const studied = (ctx: PracticeContext) => [...others(ctx, HORSE_BODIES), ...others(ctx, HUMAN_ELF_BODIES)];

const practices: Record<string, Practice> = {
  ArmsLore: {
    skill: 'ArmsLore',
    delay: 1000,
    target: (ctx) => ctx.items().filter((i) => axeWeapons.has(i.graphic)),
    refused: [500352]
  },
  Anatomy: { skill: 'Anatomy', delay: 1000, target: studied, refused: [500324, 500326] },
  EvalInt: { skill: 'EvalInt', delay: 1000, target: studied, refused: [500324, 500326] },
  AnimalLore: { skill: 'AnimalLore', delay: 1000, target: (ctx) => others(ctx, HORSE_BODIES) },
  Hiding: { skill: 'Hiding', delay: 10000, target: 'none' },
  DetectHidden: { skill: 'DetectHidden', delay: 10000, target: 'ground' },
  Stealth: { skill: 'Stealth', delay: 10000, target: 'none', before: 'Hiding' },
  // Active skills without a target (a warlock's Spirit Speak; Meditation while short of mana).
  SpiritSpeak: { skill: 'SpiritSpeak', delay: 5000, target: 'none' },
  Meditation: { skill: 'Meditation', delay: 5000, target: 'none' }
};

export async function practiseSkill(ctx: PracticeContext, practice: Practice) {
  const { session, check, phase, log } = ctx;
  const id = skillId(practice.skill);
  const refused = new Set<number>();
  let uses = 0;
  if (typeof practice.target === 'function' && !practice.target(ctx).length) {
    log(`Cannot practise ${practice.skill}: no suitable observed target`);
    return 0;
  }
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
    try {
      if (practice.target === 'none') {
        session.useSkill(id);
        await session.waitFor(() => feedback() !== undefined, `${practice.skill} result`, 3000).catch(() => {});
        if (feedback()?.cliloc !== ShardMessage.tooSoon) uses++;
      } else {
        const here = session.world.position;
        const aim = target ? onItem(target) : here ? onTile(here) : undefined;
        if (aim) {
          const used = await useOn(session, () => session.useSkill(id), aim, {
            label: 'skill cursor',
            refusals: [ShardMessage.tooSoon]
          });
          if (!('why' in used)) uses++;
        }
        await Bun.sleep(400);
        const reply = feedback()?.cliloc;
        if (target && reply !== undefined && practice.refused?.includes(reply)) refused.add(target.serial);
      }
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      if (session.world.target) session.target(null);
    }
    await checkedDelay(Math.max(0, practice.delay + 150 + Math.random() * 450 - (Date.now() - startedAt)), ctx.check);
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
// Iron for tinkering practice: the tinker's 16-ingot stock.
const ironRefill =
  (shop: NonNullable<TrainingContext['shop']>) =>
  async (_backpack: number, least: number): Promise<boolean> => {
    const want = Math.max(least * 3, 30);
    return buyFrom(shop, 'tinker', new Map([[goods['iron ingots'].graphic, Math.min(want, 16)]]));
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
  Magery: ({ shop, until }) => (shop ? trainMagery(shop, until) : Promise.resolve(0)),
  // Scrolls of the spells in the book (scribe.ts); Wraith Form on and off for Necromancy.
  Inscription: ({ shop, until }) => (shop ? practiseInscription(shop, until) : Promise.resolve(0)),
  Necromancy: (ctx) => practiseNecromancy(ctx)
};

// The archetype's supporting skills that can still be practised: a trainer exists and the skill is
// below its cap and not locked (a maxed skill, 100.0 on the pinned shard, is never practised again).
// A supporting skill follows the character's main skills: it is not practised more than 20 points
// above the weakest of them, so idle practice cannot fill the skill cap with Anatomy and Eval Int
// while the weapon skill or Magery that the next stage needs stays where it started.
const LEAD = 20;
const PRACTISED_PRIMARIES = new Set(['Inscription', 'Necromancy']);
export function trainable(session: PlayerSession, archetype?: CharacterArchetype): string[] {
  const base = (name: string) => session.world.skills.get(skillId(name))?.base ?? 0;
  const primaries = archetype?.primarySkills ?? [];
  const ceiling = primaries.length ? Math.min(...primaries.map(base)) + LEAD : Infinity;
  // Primary skills whose only practice is this (no trade or fight trains them): a scribe mage's
  // Inscription, a warlock's Necromancy. They are not held to the ceiling of the weakest primary.
  const primaryPractice = primaries.filter((name) => PRACTISED_PRIMARIES.has(name));
  const supporting = (supportingOf(archetype) ?? ['Arms Lore']).filter((name) => {
    const skill = session.world.skills.get(skillId(name));
    return (
      !!trainers[name.replaceAll(' ', '')] &&
      (skill?.base ?? 0) < Math.min(skill?.cap ?? 100, ceiling) &&
      skill?.lock !== 2
    );
  });
  const own = primaryPractice.filter((name) => {
    const skill = session.world.skills.get(skillId(name));
    return (skill?.base ?? 0) < (skill?.cap ?? 100) && skill?.lock !== 2;
  });
  return [...own, ...supporting];
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
