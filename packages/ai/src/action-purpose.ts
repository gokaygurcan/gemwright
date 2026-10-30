import type { PlayerSession } from '@gemwright/network/session';

import { ActionTimeout } from './action-errors';
import { actionKind, actionScope, urgentActive } from './execution-session';
import { perceptionFor } from './perception-session';

export type ActionPurpose = 'combat' | 'escape';
export const takingUrgentAction = (session: PlayerSession) => ['combat', 'escape'].includes(actionKind(session) ?? '');
export const escapingDanger = (session: PlayerSession) => actionKind(session) === 'escape';
export const recentlyHurt = (session: PlayerSession, now = Date.now()) => perceptionFor(session).damagedRecently(now);
export const canPause = (session: PlayerSession) => !urgentActive(session) && !recentlyHurt(session);
export const urgentAction = async <T>(
  session: PlayerSession,
  purpose: ActionPurpose,
  act: () => Promise<T>
): Promise<T> => {
  try {
    return await actionScope(session, purpose, `${purpose} response`, act);
  } catch (error) {
    // An urgent action that used its whole budget (an escape that kept running) has ended: the
    // resident carries on with its work. Letting the timeout travel stopped whole runs — a fisher
    // stood still for the rest of its day because a flight had taken a hundred seconds.
    if (!(error instanceof ActionTimeout)) throw error;
    // A timed-out urgent action counts as unsupported: callers test the result truthily.
    return undefined as T;
  }
};
export { ActionTimeout, DangerInterrupt } from './action-errors';

export async function checkedDelay(ms: number, check: () => void) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    check();
    await Bun.sleep(Math.min(250, until - Date.now()));
  }
  check();
}
