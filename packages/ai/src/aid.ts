import { HUMAN_BODIES } from '@gemwright/common/bodies';

import { isResident } from './activity';
import { threatsNear } from './danger';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity, JournalEntry } from './protocol/world';
import { residentContext } from './resident-context';
import { rememberPartner } from './resident-memory';
import type { Terrain } from './terrain';

interface Support {
  serial: number;
  name: string;
  until: number;
  confirmed: boolean;
  recorded?: boolean;
}
const support = new WeakMap<PlayerSession, Map<number, Support>>();
export const offersHelp =
  /\b(?:let me help|i(?:['’]?m| am) (?:here to help|helping)|i(?:['’]?ve| have) got (?:you|this)|get behind me|i(?:['’]?ll| will) (?:heal|cover|help) you)\b/i;

export function hearAid(session: PlayerSession, entry: JournalEntry): boolean {
  const here = session.world.position,
    speaker = session.world.entities.get(entry.serial);
  if (
    !here ||
    !speaker?.position ||
    distance(here, speaker.position) > 12 ||
    !offersHelp.test(entry.text ?? '') ||
    entry.serial === session.world.serial ||
    Date.now() - Date.parse(entry.at) > 15_000
  )
    return false;
  const list = support.get(session) ?? new Map<number, Support>();
  list.set(entry.serial, {
    serial: entry.serial,
    name: speaker.name ?? entry.name,
    until: Date.now() + 60_000,
    confirmed: false
  });
  support.set(session, list);
  return true;
}

export function observeAid(session: PlayerSession): Entity[] {
  const here = session.world.position,
    self = session.world.serial;
  if (!here || self === null) return [];
  const now = Date.now(),
    list = support.get(session) ?? new Map<number, Support>();
  support.set(session, list);
  const threats = new Set(
    [...session.world.swings]
      .filter(([, swing]) => swing.target === self && now - swing.at >= 0 && now - swing.at < 8000)
      .map(([serial]) => serial)
  );
  if (session.world.combatant) threats.add(session.world.combatant);
  for (const [serial, swing] of session.world.swings) {
    const entity = session.world.entities.get(serial);
    if (
      serial === self ||
      isResident(serial) ||
      !entity?.position ||
      !HUMAN_BODIES.has(entity.graphic) ||
      ![1, 2].includes(entity.notoriety ?? 0) ||
      distance(here, entity.position) > 12 ||
      now - swing.at < 0 ||
      now - swing.at > 8000 ||
      !threats.has(swing.target)
    )
      continue;
    list.set(serial, {
      ...list.get(serial),
      serial,
      name: entity.name ?? 'friend',
      until: now + 30_000,
      confirmed: true
    });
  }
  const ctx = residentContext(session);
  for (const [serial, helper] of list) {
    if (helper.until < now || !session.world.entities.get(serial)?.position) {
      list.delete(serial);
      continue;
    }
    const recovering = session.world.healthChanges.some(
      (change) => change.healed > 0 && now - change.at >= 0 && now - change.at < 4000
    );
    if (!helper.recorded && ctx && (helper.confirmed || recovering)) {
      rememberPartner(ctx.checkpoint, {
        partner: serial,
        name: helper.name,
        kind: 'rescue',
        detail: helper.confirmed
          ? 'Attacked a creature threatening me'
          : 'Offered help and stayed nearby while I recovered',
        id: `aid:${serial}:${Math.floor(now / 60_000)}`
      });
      helper.recorded = true;
      ctx.persist?.();
    }
  }
  return [...list.values()]
    .filter((helper) => helper.confirmed || helper.until > now)
    .flatMap((helper) => session.world.entities.get(helper.serial) ?? [])
    .filter((entity) => entity.position && distance(here, entity.position) <= 12);
}

export function supportPreference(session: PlayerSession, point: { x: number; y: number }): number {
  const helpers = observeAid(session);
  return helpers.length ? Math.min(...helpers.map((entity) => distance(point, entity.position ?? point))) * 0.7 : 0;
}

export async function shelterNearHelper(session: PlayerSession, terrain: Terrain, check: () => void) {
  const here = session.world.position;
  if (!here) return undefined;
  const threats = threatsNear(session, here, 14);
  for (const helper of observeAid(session)) {
    if (!helper.position) continue;
    for (const [dx, dy] of [
      [0, 2],
      [2, 0],
      [0, -2],
      [-2, 0]
    ] as const) {
      check();
      const spot = terrain.stand(helper.position.x + dx, helper.position.y + dy, here.z);
      if (!spot || threats.some((enemy) => enemy.position && distance(spot, enemy.position) < 4)) continue;
      const path = await terrain.pathAsync(here, spot, 0, undefined, spot.z, session.signal);
      if (
        path?.length &&
        path.length <= 12 &&
        !path.some((step) => threats.some((enemy) => enemy.position && distance(step, enemy.position) < 2))
      )
        return spot;
    }
  }
  return undefined;
}
