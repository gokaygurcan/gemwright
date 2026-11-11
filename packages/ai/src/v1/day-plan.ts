import type { PlayerSession } from '@gemwright/network/session';

import { lastCoreProgressAt } from './loop-watch';

// The day is one account. A resident's core work — the profession's own output — gets the time;
// side work (restocking, earning, social trips) is allowed only while the core work is current and
// only for a bounded share of the hour. Without this, every layer could start a trip of its own and
// the day went to shopping: a fighter restocking all evening, a fisher walking to Minoc to "earn".
const CORE_STALE_MS = 12 * 60_000;
const SIDE_BUDGET_MS = 20 * 60_000;
const SIDE_WINDOW_MS = 60 * 60_000;
const spent = new WeakMap<PlayerSession, { at: number; ms: number }>();

export function coreStale(session: PlayerSession, now = Date.now()) {
  return now - lastCoreProgressAt(session) > CORE_STALE_MS;
}

// True when side work may take the turn: the core work is current and the hour's side budget is not
// yet spent.
export function sideWorkAllowed(session: PlayerSession, now = Date.now()) {
  if (coreStale(session, now)) return false;
  const side = spent.get(session);
  if (!side || now - side.at > SIDE_WINDOW_MS) return true;
  return side.ms < SIDE_BUDGET_MS;
}

export function noteSideWork(session: PlayerSession, ms: number, now = Date.now()) {
  const side = spent.get(session);
  if (!side || now - side.at > SIDE_WINDOW_MS) spent.set(session, { at: now, ms });
  else side.ms += ms;
}
