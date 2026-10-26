import type { CharacterTemplate } from './config';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import type { Checkpoint } from './store';
import type { Terrain } from './terrain';

export interface ResidentContext {
  session: PlayerSession;
  checkpoint: Checkpoint;
  template: CharacterTemplate;
  city: string;
  persist?: () => void;
}
const residents = new WeakMap<PlayerSession, ResidentContext>();
const terrain = new WeakMap<PlayerSession, Terrain>();
const combat = new WeakMap<
  PlayerSession,
  {
    canFight: (target: Entity) => boolean;
    fight: (target: Entity) => Promise<void>;
    support?: () => Promise<boolean>;
    ready?: () => boolean;
  }
>();
const schedules = new WeakSet<PlayerSession>();
export const registerResident = (ctx: ResidentContext) => residents.set(ctx.session, ctx);
export const residentContext = (session: PlayerSession) => residents.get(session);
export const registerTerrain = (session: PlayerSession, value: Terrain) => terrain.set(session, value);
export const residentTerrain = (session: PlayerSession) => terrain.get(session);
export const registerCombat = (session: PlayerSession, value: NonNullable<ReturnType<typeof residentCombat>>) =>
  combat.set(session, value);
export const residentCombat = (session: PlayerSession) => combat.get(session);
export const enableSessionHabits = (session: PlayerSession) => schedules.add(session);
export const hasSessionHabits = (session: PlayerSession) => schedules.has(session);
