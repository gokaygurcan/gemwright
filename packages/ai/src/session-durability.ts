import type { PlayerSession } from '@gemwright/network/session';

const barriers = new WeakMap<PlayerSession, () => Promise<void>>();
export const registerDurability = (session: PlayerSession, flush: () => Promise<void>) => barriers.set(session, flush);
export const flushSession = (session: PlayerSession) => barriers.get(session)?.() ?? Promise.resolve();
