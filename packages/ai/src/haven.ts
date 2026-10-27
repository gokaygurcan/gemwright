import { readFileSync } from 'node:fs';

import type { CharacterArchetype } from './archetypes';
import type { CharacterTemplate } from './config';
import { outgrewYoung } from './progression';
import type { PlayerSession } from './protocol/session';

// New Haven (locations/new-haven.json, built from a world save and Regions.xml): the island town
// where new players begin. Residents of the New Haven cohort start there, and while Young they
// never leave Haven Island: every walk, moongate trip, visit, dungeon run and escort stays on it.
// Out of Young status (a primary skill at 60, progression.ts) they go where they like; it stays
// their home.
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface HavenGround {
  name: string;
  center: { x: number; y: number };
  radius: number;
  creatures: Record<string, number>;
}
export const haven = JSON.parse(readFileSync(new URL('../locations/new-haven.json', import.meta.url), 'utf8')) as {
  island: Box;
  town: Box;
  moongate: { x: number; y: number; z: number };
  mines: { x: number; y: number; radius: number };
  docks: { x: number; y: number };
  services: Record<string, { name: string; x: number; y: number }[]>;
  grounds: HavenGround[];
};
export const HAVEN_CITY = 'New Haven';
const inside = (box: Box, p: { x: number; y: number }) =>
  p.x >= box.x0 && p.x < box.x1 && p.y >= box.y0 && p.y < box.y1;
export const onHaven = (point: { x: number; y: number }) => inside(haven.island, point);

const members = new WeakMap<PlayerSession, CharacterArchetype | undefined>();
export const isHavenTemplate = (template: Pick<CharacterTemplate, 'creation'>) => template.creation.city === HAVEN_CITY;
// A resident of the New Haven cohort (run-session.ts registers it at login).
export function registerHaven(session: PlayerSession, template: CharacterTemplate) {
  if (isHavenTemplate(template)) members.set(session, template.archetype);
}
export const havenResident = (session: PlayerSession) => members.has(session);
// Still Young, so bound to the island.
export const confinedToHaven = (session: PlayerSession) =>
  members.has(session) && !outgrewYoung(session, members.get(session));
