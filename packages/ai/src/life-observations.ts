import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { skillNames } from '@gemwright/common/game/skills';
import type { PlayerSession } from '@gemwright/network/session';

import { currentLifeTarget, entityDetails, lifeEvent } from './life-events';

// Records server observations, without treating nearby deaths as this resident's kills or
// guessing a killer from proximity. This protocol does not identify the killing blow's source.
export function observeLife(session: PlayerSession) {
  const world = session.world;
  const skills = new Map([...world.skills].map(([id, s]) => [id, s.base]));
  let hits = world.status?.hits;
  let gold = world.status?.gold;
  let dead = false;
  let ghostSeen = false;
  let entered = false;
  let previousMap = world.map;
  let previousPosition = world.position ? { ...world.position } : null;
  let lastJournal = world.journal.at(-1);
  const stop = world.observations.subscribe(
    (change) => {
      if (!change.decoded) return;
      if (world.ready && !entered) {
        entered = true;
        lifeEvent(session, 'session_entered_world', 'observed', { character: world.serial });
      }
      const body = world.serial === null ? undefined : world.entities.get(world.serial)?.graphic;
      const nowDead =
        (body !== undefined && GHOST_BODIES.has(body)) ||
        change.events.some(
          (event) => event.type === 'self-death' || (event.type === 'entity-death' && event.serial === world.serial)
        );
      if (body !== undefined && GHOST_BODIES.has(body)) ghostSeen = true;
      if (nowDead && !dead) {
        const recentAttackers = [...world.swings]
          .filter(([, swing]) => swing.target === world.serial && Date.now() - swing.at < 10_000)
          .map(([serial]) => entityDetails(session, serial));
        lifeEvent(session, 'death', 'observed', {
          killer: null,
          killerEvidence: 'not supplied by protocol',
          recentAttackers,
          location: world.deathSite ?? world.position,
          healthBefore: hits ?? null
        });
        dead = true;
      } else if (dead && ghostSeen && body !== undefined && !GHOST_BODIES.has(body) && (world.status?.hits ?? 0) > 0) {
        lifeEvent(session, 'resurrection', 'observed', { hits: world.status?.hits });
        dead = false;
        ghostSeen = false;
      }
      const status = world.status;
      if (status) {
        if (hits !== undefined && status.hits !== hits)
          lifeEvent(session, status.hits < hits ? 'damage_taken' : 'health_recovered', 'observed', {
            before: hits,
            after: status.hits,
            amount: Math.abs(status.hits - hits)
          });
        if (gold !== undefined && status.gold !== gold)
          lifeEvent(session, 'carried_gold_changed', 'observed', {
            before: gold,
            after: status.gold,
            change: status.gold - gold
          });
        hits = status.hits;
        gold = status.gold;
      }
      if (change.skills.length) {
        for (const [id, skill] of world.skills) {
          const before = skills.get(id);
          if (before !== undefined && before !== skill.base)
            lifeEvent(session, 'skill_changed', 'observed', {
              skill: skillNames[id] ?? id,
              before,
              after: skill.base,
              change: skill.base - before
            });
          skills.set(id, skill.base);
        }
      }
      for (const event of change.events) {
        if (event.type === 'entity-death')
          lifeEvent(session, 'death_witnessed', 'observed', {
            subject: entityDetails(session, event.serial),
            corpse: event.corpse,
            creditedKill: false
          });
        if (event.type === 'movement-rejected')
          lifeEvent(session, 'movement_rejected', 'observed', { correctedPosition: world.position });
      }

      if (
        previousPosition &&
        world.position &&
        (previousMap !== world.map ||
          Math.max(Math.abs(previousPosition.x - world.position.x), Math.abs(previousPosition.y - world.position.y)) >
            32)
      )
        lifeEvent(session, 'position_changed', 'observed', {
          from: { map: previousMap, ...previousPosition },
          to: { map: world.map, ...world.position }
        });
      previousMap = world.map;
      previousPosition = world.position ? { ...world.position } : null;
      const journal = world.journal.at(-1);
      if (
        journal &&
        journal !== lastJournal &&
        journal.type !== 6 &&
        [0, 0xffffffff, world.serial, currentLifeTarget(session)].includes(journal.serial)
      ) {
        lifeEvent(session, 'server_message', 'observed', {
          speaker: journal.serial,
          name: journal.name,
          text: journal.text?.slice(0, 1000),
          cliloc: journal.cliloc,
          arguments: journal.arguments?.slice(0, 1000)
        });
      }
      lastJournal = journal;
    },
    (error) => lifeEvent(session, 'life_observation', 'failed', { reason: String(error) })
  );
  session.signal?.addEventListener('abort', stop, { once: true });
}
