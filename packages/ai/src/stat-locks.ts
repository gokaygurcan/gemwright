import { skillId } from '@gemwright/common/skills';

import type { CharacterArchetype } from './archetypes';
import { supportingOf } from './archetypes';
import { outgrewYoung, readyForDungeons, renounceYoung } from './progression';
import type { PlayerSession } from './protocol/session';

// ServUO StatLockType: Up 0, Down 1, Locked 2 (Mobile.cs); gains only raise Up stats and take
// from Down ones once the stat cap is reached.
export function desiredLock(current: number, target: number): 0 | 1 | 2 {
  return current < target ? 0 : current > target ? 1 : 2;
}

// Keeps every lock pointed at the build. Stats: rise below the archetype target, hold at it, fall
// above it. Skills: build skills (primary, supporting, template goals) rise until their cap and
// then lock; every other skill falls, so the 700-point total goes to the build.
export function maintainLocks(session: PlayerSession, archetype: CharacterArchetype, goals: string[]) {
  // Fishing stays open too: it is the side trade anyone may take up (side-trade.ts).
  const build = new Set(
    [...archetype.primarySkills, ...(supportingOf(archetype) ?? []), ...goals, 'Fishing'].map(skillId)
  );
  const sentStats: number[] = [];
  let announced = false;
  let renounced = false;
  const applyStats = () => {
    const status = session.world.status;
    if (session.phase !== 'ready' || !status) return;
    const values = [status.strength, status.dexterity, status.intelligence];
    const targets = [archetype.stats.str, archetype.stats.dex, archetype.stats.int];
    for (let stat = 0; stat < 3; stat++) {
      const lock = desiredLock(values[stat] ?? 0, targets[stat] ?? 0);
      if ((sentStats[stat] ?? session.world.statLocks?.[stat]) === lock) continue;
      session.setLock('stat', stat, lock);
      sentStats[stat] = lock;
    }
  };
  const applySkills = async () => {
    if (session.phase !== 'ready') return;
    await session.refreshSkills();
    if (!announced && readyForDungeons(session, archetype)) {
      announced = true;
      const name = session.world.serial === null ? '' : session.world.entities.get(session.world.serial)?.name;
      console.log(`[progression] ${name ?? 'resident'} has 80.0 primaries; ready for dungeons once designed`);
    }
    // Once per session: a character that is no longer Young is offered no gump.
    if (!renounced && outgrewYoung(session, archetype)) {
      renounced = true;
      if (await renounceYoung(session)) console.log('[progression] renounced Young status at 60.0 primary skill');
    }
    for (const [id, skill] of session.world.skills) {
      const lock = build.has(id) ? (skill.base >= skill.cap ? 2 : 0) : 1;
      if (skill.lock === lock) continue;
      session.setLock('skill', id, lock);
      skill.lock = lock;
    }
  };
  const quietly = (run: () => unknown) => {
    try {
      Promise.resolve(run()).catch(() => {});
    } catch {
      // A closed or failed session is handled by the behavior supervisor.
    }
  };
  quietly(applyStats);
  quietly(applySkills);
  // Stats and skills move slowly; checks every minute (stats) and five minutes (skills) suffice.
  const stats = setInterval(() => quietly(applyStats), 60_000);
  const skills = setInterval(() => quietly(applySkills), 5 * 60_000);
  return () => {
    clearInterval(stats);
    clearInterval(skills);
  };
}
