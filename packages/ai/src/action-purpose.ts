import type { PlayerSession } from './protocol/session';

export type ActionPurpose = 'combat' | 'escape';
const purposes = new WeakMap<PlayerSession, Set<symbol>>();

export function takingUrgentAction(session: PlayerSession): boolean {
  return !!purposes.get(session)?.size;
}

export function recentlyHurt(session: PlayerSession, now = Date.now()): boolean {
  return session.world.healthChanges.some(
    (change) => change.damage > 0 && now - change.at >= 0 && now - change.at < 8000
  );
}

export const canPause = (session: PlayerSession) => !takingUrgentAction(session) && !recentlyHurt(session);

export async function urgentAction<T>(
  session: PlayerSession,
  _purpose: ActionPurpose,
  act: () => Promise<T>
): Promise<T> {
  const active = purposes.get(session) ?? new Set<symbol>();
  const token = Symbol();
  active.add(token);
  purposes.set(session, active);
  try {
    return await act();
  } finally {
    active.delete(token);
    if (!active.size) purposes.delete(session);
  }
}

export class DangerInterrupt extends Error {
  constructor() {
    super('Taking damage; leaving work to get to safety');
  }
}

export async function checkedDelay(ms: number, check: () => void) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    check();
    await Bun.sleep(Math.min(250, until - Date.now()));
  }
  check();
}
