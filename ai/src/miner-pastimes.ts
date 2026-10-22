import type { CharacterArchetype } from './archetypes';
import { Blocked } from './blocked';
import type { CharacterTemplate } from './config';
import type { DecisionCoordinator } from './decisions';
import type { LifeContext } from './life';
import type { createMinerServices } from './miner-services';
import type { createNavigator } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity, Position } from './protocol/world';
import { scavenge } from './scavenge';
import { passSetback } from './setback';
import { trainSupportingSkill } from './skill-training';
import type { Terrain } from './terrain';
import { trainingVisit } from './training';

export type Pastime = 'smith' | 'train' | 'learn' | 'wander';

// Weighted pick; residents never quit for lack of ore, they choose something else to do.
export function choosePastime(options: Pastime[], random = Math.random): Pastime | undefined {
  const weights: Record<Pastime, number> = { smith: 3, train: 4, learn: 2, wander: 2 };
  const total = options.reduce((sum, option) => sum + weights[option], 0);
  let roll = random() * total;
  for (const option of options) {
    roll -= weights[option];
    if (roll < 0) return option;
  }
  return options.at(-1);
}

// Runs one non-mining activity; returns false when it could not be done, so the caller tries another.
export function createPastimes(ctx: {
  session: PlayerSession;
  terrain: Terrain;
  serial: number;
  position: () => Position;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  navigate: ReturnType<typeof createNavigator>;
  carried: (backpack: number) => Entity[];
  smithFromBank: (backpack: number) => Promise<boolean>;
  deadline: number;
  archetype?: CharacterArchetype;
  // Paid NPC lessons for skills still below the teachable range; resolves once the visit is done.
  learn: () => Promise<void>;
  // Vendor access and material refills for shop-dependent supporting skills.
  shop?: Parameters<typeof trainSupportingSkill>[0]['shop'];
}) {
  const { session, terrain, check, phase, log } = ctx;
  const run = async (pastime: Pastime, backpack: number): Promise<boolean> => {
    if (pastime === 'smith') return ctx.smithFromBank(backpack);
    if (pastime === 'train') {
      const until = Math.min(ctx.deadline, Date.now() + (2 + Math.random() * 4) * 60_000);
      const items = () => [
        ...ctx.carried(backpack),
        ...[...session.world.entities.values()].filter((item) => item.parent === ctx.serial)
      ];
      return (
        (await trainSupportingSkill({
          session,
          check,
          phase,
          log,
          items,
          until,
          archetype: ctx.archetype,
          shop: ctx.shop
        })) > 0
      );
    }
    if (pastime === 'learn') {
      await ctx.learn();
      return false;
    }
    // A stroll to a nearby standing spot, as a player stretching between veins.
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const reach = 15 + Math.random() * 25;
      const from = ctx.position();
      const spot = terrain.stand(
        Math.round(from.x + Math.cos(angle) * reach),
        Math.round(from.y + Math.sin(angle) * reach),
        from.z
      );
      if (!spot) continue;
      phase('wandering', `Walking over to ${spot.x},${spot.y} before looking for ore again`);
      try {
        await ctx.navigate(spot, 2);
        return true;
      } catch (error) {
        if (!(error instanceof Blocked)) throw error;
      }
    }
    return false;
  };
  // Tries a random order of the given pastimes until one succeeds; rests briefly if none could.
  return async (backpack: number, options: Pastime[] = ['smith', 'train', 'learn', 'wander']) => {
    const remaining = [...options];
    while (remaining.length) {
      const pick = choosePastime(remaining);
      if (!pick) break;
      remaining.splice(remaining.indexOf(pick), 1);
      if (await run(pick, backpack)) return pick;
    }
    phase('resting', 'Taking a short break before looking for ore again');
    const resumeAt = Math.min(Date.now() + 30_000, ctx.deadline);
    while (Date.now() < resumeAt) {
      check();
      await Bun.sleep(2000);
    }
    return undefined;
  };
}

// Miner wiring: lessons in the miner's own city (a walk back from Britain to Minoc is beyond path
// search) and Tinkering with banked iron.
export function createMinerPastimes(
  services: Parameters<typeof createMinerServices>[0],
  extra: {
    smithFromBank: (backpack: number) => Promise<boolean>;
    withdrawIngots: (backpack: number, least: number, most: number) => Promise<boolean>;
    deadline: number;
    template: CharacterTemplate;
    backpack: () => number;
    resupply: (backpack: number) => Promise<void>;
  }
) {
  const { session } = services;
  const pastime = createPastimes({
    ...services,
    smithFromBank: extra.smithFromBank,
    deadline: extra.deadline,
    archetype: extra.template.archetype,
    learn: () =>
      trainingVisit(
        {
          ...services,
          backpack: extra.backpack,
          template: extra.template,
          nearby: () => [...session.world.entities.values()].filter((e) => e.kind === 'mobile' && e.position)
        },
        services.city
      ),
    shop: {
      ...services,
      backpack: extra.backpack,
      refills: { Tinkering: (pack, least) => extra.withdrawIngots(pack, least, 60) }
    }
  });
  const setback = (reason: string) =>
    passSetback(
      {
        ...services,
        deadline: extra.deadline,
        archetype: extra.template.archetype,
        items: () => [...session.world.childrenOf(services.serial), ...services.carried(extra.backpack())]
      },
      reason
    );
  // Sold-out tool vendors restock; pass the time and retry.
  const resupplyOrPass = async (backpack: number) => {
    try {
      await extra.resupply(backpack);
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      services.log(
        `${error.message}; chose ${(await pastime(backpack, ['learn', 'train', 'wander'])) ?? 'a short rest'}`
      );
    }
  };
  // The miner's life between trips (life.ts): errands are a bank visit, practice a pastime.
  const life = (bank: (backpack: number) => Promise<void>, decisions?: DecisionCoordinator): LifeContext => ({
    session,
    terrain: services.terrain,
    template: extra.template,
    checkpoint: services.checkpoint,
    city: services.city,
    position: services.position,
    check: services.check,
    phase: services.phase,
    log: services.log,
    persist: services.persist,
    navigate: services.navigate,
    decisions,
    practise: () => pastime(extra.backpack(), ['learn', 'train']),
    errands: () => bank(extra.backpack())
  });
  // Loose items worth having near the miner (scavenge.ts).
  const pickUp = (backpack: number) => scavenge({ ...services, backpack: () => backpack });
  return { pastime, setback, resupplyOrPass, life, pickUp };
}
