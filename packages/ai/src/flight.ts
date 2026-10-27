import { GARGOYLE_BODIES } from '@gemwright/common/bodies';

import { canPause } from './action-purpose';
import type { PlayerSession } from './protocol/session';

// Gargoyle flight (ServUO FlySpell, SA): a gargoyle cannot ride, but takes wing for a long walk,
// a two-second take-off without mana that a blow disturbs, and lands when it gets there. On this
// shard flight does not change speed (Mobile.ComputeMovementSpeed counts only a mount), so it is
// how gargoyles travel, not a shortcut. The client shows it with status flag 0x04.
const FLYING = 0x04;
const self = (session: PlayerSession) => session.world.entities.get(session.world.serial ?? -1);

export const isGargoyle = (session: PlayerSession) => GARGOYLE_BODIES.has(self(session)?.graphic ?? 0);
export const flying = (session: PlayerSession) => ((self(session)?.flags ?? 0) & FLYING) !== 0;

// Takes off before a long walk, when nothing presses; true when in the air.
export async function takeOff(session: PlayerSession) {
  if (!isGargoyle(session) || flying(session) || !canPause(session) || session.world.target) return flying(session);
  session.toggleFlying();
  await session.waitFor(() => flying(session), 'take-off', 3500).catch(() => {});
  return flying(session);
}

// Lands where it arrived.
export async function land(session: PlayerSession) {
  if (!flying(session)) return;
  session.toggleFlying();
  await session.waitFor(() => !flying(session), 'landing', 3500).catch(() => {});
}
