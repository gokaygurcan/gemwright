import type { CharacterTemplate } from './config';
import { type DecisionCoordinator, decisionGuard, decisionState } from './decisions';
import { forges } from './miner-services';
import type { PlayerSession } from './protocol/session';
import type { Checkpoint } from './store';
import type { Point } from './terrain';

const distance = (a: Point, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// A miner's remembered depleted veins and its trip plan (when to smelt, when to bank).
export function minerPlan(checkpoint: Checkpoint, template: CharacterTemplate, save: () => void) {
  checkpoint.landmarks ??= { forges: [] };
  // ServUO ore veins respawn 10-20 minutes after depletion (Mining.cs), so a depleted spot is
  // remembered across restarts for the longest respawn and then tried again.
  const depleted = new Map(
    (checkpoint.landmarks.depleted ?? []).filter((entry) => entry.until > Date.now()).map((e) => [e.key, e.until])
  );
  const exhausted = {
    has: (key: string) => (depleted.get(key) ?? 0) > Date.now(),
    add: (key: string) => {
      depleted.set(key, Date.now() + 20 * 60_000);
      if (checkpoint.landmarks)
        checkpoint.landmarks.depleted = [...depleted]
          .filter(([, until]) => until > Date.now())
          .slice(-300)
          .map(([k, until]) => ({ key: k, until }));
      save();
    }
  };
  const newTrip = () => {
    const roll = Math.random();
    const ceiling = Math.min(0.9, template.behavior.bankAtWeightRatio);
    return {
      smeltsSinceBank: 0,
      smeltsBeforeBank: roll < 0.2 ? 1 : roll < 0.75 ? 2 : roll < 0.95 ? 3 : 4,
      smeltAtWeightRatio: ceiling * (0.8 + Math.random() * 0.2),
      bankAtWeightRatio: ceiling * (0.9 + Math.random() * 0.1)
    };
  };
  checkpoint.mining ??= newTrip();
  const plan = () => {
    if (!checkpoint.mining) throw new Error('Miner trip plan is missing');
    return checkpoint.mining;
  };
  return { exhausted, newTrip, plan };
}

// Forges seen within 18 tiles, remembered (up to 16) so a later smelt can head straight back.
export function rememberForges(session: PlayerSession, checkpoint: Checkpoint, here: Point) {
  for (const item of session.world.entities.values()) {
    const location = item.position;
    if (item.kind !== 'item' || !location || !forges.has(item.graphic) || distance(here, location) > 18) continue;
    const remembered = checkpoint.landmarks?.forges ?? [];
    if (!remembered.some((forge) => distance(forge, location) === 0 && forge.z === location.z))
      checkpoint.landmarks = {
        ...checkpoint.landmarks,
        forges: [{ x: location.x, y: location.y, z: location.z }, ...remembered].slice(0, 16)
      };
  }
}

// The decision provider's choice between mining on, smelting now and banking early.
export function chooseMiningActivity(
  decisions: DecisionCoordinator,
  session: PlayerSession,
  template: CharacterTemplate,
  checkpoint: Checkpoint,
  at: {
    city: string;
    plan: NonNullable<Checkpoint['mining']>;
    ceiling: number;
    ore: number;
    canMine: boolean;
    canBank: boolean;
    stopping?: () => boolean;
  }
) {
  return decisions.choose({
    kind: 'mining-activity',
    checkpoint,
    state: decisionState(session, template, checkpoint, {
      profession: 'miner',
      home: at.city,
      smeltsSinceBank: at.plan.smeltsSinceBank,
      tripSmeltGoal: at.plan.smeltsBeforeBank,
      weightCeiling: at.ceiling,
      oreStacks: at.ore,
      note: 'Ingots, gold and ore the forge refused are banked. Smelting reduces carried weight. Mine while capacity allows; smelt before travelling to bank. A town trip costs travel time.'
    }),
    observationRevision: session.world.revision,
    baseline: 'mine',
    stillCurrent: decisionGuard(session, at.stopping),
    candidates: [
      {
        id: 'mine',
        description: 'Continue mining with a carried tool and available backpack capacity.',
        valid: () => at.canMine
      },
      {
        id: 'smelt',
        description:
          'Visit the nearby forge now and convert carried smeltable ore to lighter usable ingots, then reassess.',
        valid: () => at.ore > 0
      },
      {
        id: 'bank',
        description: 'Return to the city bank early with the carried ingots, then restock and start another trip.',
        valid: () => at.canBank
      }
    ]
  });
}
