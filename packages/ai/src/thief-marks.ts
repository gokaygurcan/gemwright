import { HUMAN_ELF_BODIES } from '@gemwright/common/bodies';

import { cemeteries, patrolPoints } from './cemeteries';
import { monsters } from './dungeons';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import type { Entity, Position, WorldView } from './protocol/world';
import type { Terrain } from './terrain';

// Graveyard undead a thief dares stand next to: the pinned shard's common tier only, Zombie
// (body 3) and Skeleton (bodies 50 and 56, Scripts/Mobiles/Normal). Ghouls, casters and knights
// share the same spawners and hit hard enough to matter for a character with no weapon skill,
// no armor and no healing.
const bodies = new Set([3, 50, 56]);
// The single-click name behind each accepted body, checked before a mark is ever approached.
const names = /^an? (zombie|skeleton)$/i;
// Health these bodies carry (Zombie 28-42, Skeleton 34-48); a stronger variant sharing a body
// graphic is left alone.
const mostHits = 60;
// BaseCreature.PackBodyPartOrBones: graveyard refuse a thief drops instead of carrying it home.
export const refuse = new Set([0x1da1, 0x1da2, 0x1d9f, 0x1da3, 0x1da4, 0x0f7e]);
// Human and player bodies are never cased. Town NPCs refuse the peek and players refuse the theft.
const humans = HUMAN_ELF_BODIES;
// Pack horse and pack llama: their StrongBackpack is the only creature pack Container_Snoop opens
// to a player; every other creature pack is refused without a reply.
const packAnimals = new Set([0x123, 0x124]);

export type TheftGround = (typeof cemeteries)[number];

// The cemetery nearest the home town, the one a thief would walk to, as fighters reach theirs.
export function groundFor(town: { x: number; y: number }): TheftGround {
  const [first, ...rest] = cemeteries;
  if (!first) throw new Error('No theft grounds are configured');
  return rest.reduce(
    (best, ground) => (distance(town, ground.center) < distance(town, best.center) ? ground : best),
    first
  );
}

export function groundPatrols(ground: TheftGround) {
  return patrolPoints(ground);
}

// The verified name of a candidate, undefined while it is still unknown (single-click it first).
export const verifyMark = (entity: Entity) => (entity.name === undefined ? undefined : names.test(entity.name));

// Any observed graveyard undead, isolated or not: a mark that is chasing the thief is noticed with
// this whether or not it is a good theft target.
export const undeadMark = (entity: Entity) =>
  entity.kind === 'mobile' &&
  bodies.has(entity.graphic) &&
  (entity.maxHits === undefined || entity.maxHits <= mostHits);

// Dungeon marks: any creature in the dungeon catalog weak enough to stand next to with no weapon
// skill or armor, whatever its kind (rats, ratmen, orcs, slimes, spiders, headless ones...): no
// spells, at most 80 health and 12 damage. Kinds with a fixed name are checked by that name;
// random-named kinds (orcs, ratmen) by body.
const weak = monsters.filter(
  (m) => m.magery === 0 && (m.hits?.[1] ?? 999) <= 80 && (m.damage?.[1] ?? 999) <= 12 && m.bodies.length
);
const weakBodies = new Set(weak.flatMap((m) => m.bodies));
export const dungeonMark = (entity: Entity) =>
  entity.kind === 'mobile' &&
  !humans.has(entity.graphic) &&
  (weakBodies.has(entity.graphic) || bodies.has(entity.graphic)) &&
  (entity.maxHits === undefined || entity.maxHits <= 80);
export const verifyDungeonMark = (entity: Entity) => {
  if (entity.name === undefined) return undefined;
  if (names.test(entity.name)) return true;
  return weak.some(
    (m) => m.bodies.includes(entity.graphic) && (!m.name || m.name.toLowerCase() === entity.name?.toLowerCase())
  );
};

// Lone marks to work on (graveyard undead unless `isMark` says otherwise). Stealing from one in a
// crowd aggros the crowd, so a mark needs no other marks within eight tiles, and the nearest comes
// first.
export function markCandidates(entities: Iterable<Entity>, from: Position, isMark = undeadMark): Entity[] {
  const undead = [...entities].flatMap((entity) =>
    isMark(entity) && entity.position ? [{ entity, position: entity.position }] : []
  );
  return undead
    .filter(
      ({ entity, position }) =>
        !undead.some((other) => other.entity.serial !== entity.serial && distance(other.position, position) <= 8)
    )
    .map(({ entity }) => entity)
    .sort((a, b) => distance(from, a.position ?? from) - distance(from, b.position ?? from));
}

// A standing tile that breaks a mark's aggro after a theft, in the opposite direction from it.
export function retreatPoint(terrain: Terrain, from: Position, mark: Position) {
  const dx = Math.sign(from.x - mark.x) || (Math.random() < 0.5 ? -1 : 1);
  const dy = Math.sign(from.y - mark.y) || (Math.random() < 0.5 ? -1 : 1);
  for (const reach of [14, 18, 22])
    for (const [stepX, stepY] of [
      [dx, dy],
      [dx, 0],
      [0, dy]
    ] as const) {
      const stand = terrain.stand(from.x + stepX * reach, from.y + stepY * reach, from.z);
      if (stand) return stand;
    }
  return undefined;
}

// Mobile packs a player may peek into (Snooping.cs Container_Snoop on the pinned revision): an
// observed backpack whose owner is not this character. Creature backpacks refuse players outright,
// town NPCs and players refuse the peek, so pack animals are the packs that remain. Fellow
// residents are never cased.
export function snoopTargets(
  world: WorldView,
  serial: number,
  peers?: ReadonlyMap<number, string>
): { owner: Entity; pack: Entity }[] {
  return [...world.entities.values()].flatMap((entity) => {
    if (entity.kind !== 'mobile' || entity.serial === serial || !entity.position) return [];
    if (humans.has(entity.graphic) || !packAnimals.has(entity.graphic) || peers?.has(entity.serial)) return [];
    const pack = world.childrenOf(entity.serial).find((item) => item.layer === Layer.Backpack);
    return pack ? [{ owner: entity, pack }] : [];
  });
}
