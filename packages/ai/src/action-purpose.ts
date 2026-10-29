import type { PlayerSession } from '@gemwright/network/session';

import { actionKind, actionScope, urgentActive } from './execution-session';
import { perceptionFor } from './perception-session';

export type ActionPurpose = 'combat' | 'escape';
export const takingUrgentAction = (session: PlayerSession) => ['combat', 'escape'].includes(actionKind(session) ?? '');
export const escapingDanger = (session: PlayerSession) => actionKind(session) === 'escape';
export const recentlyHurt = (session: PlayerSession, now = Date.now()) => perceptionFor(session).damagedRecently(now);
export const canPause = (session: PlayerSession) => !urgentActive(session) && !recentlyHurt(session);
export const urgentAction = <T>(session: PlayerSession, purpose: ActionPurpose, act: () => Promise<T>) =>
  actionScope(session, purpose, `${purpose} response`, act);
export { DangerInterrupt } from './action-errors';

export async function checkedDelay(ms: number, check: () => void) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    check();
    await Bun.sleep(Math.min(250, until - Date.now()));
  }
  check();
}
