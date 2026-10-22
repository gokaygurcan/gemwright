import type { CharacterTemplate } from './config';
import type { Checkpoint } from './store';

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
