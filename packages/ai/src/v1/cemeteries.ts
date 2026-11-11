import { lasting } from '../lasting';
import { monsters } from '../monster-reference';
import type { Rect, Spawner } from '../spawns';
import { keepsFailing } from '../trouble';
import { WALKING_LIMIT } from '../tuning';
import { absence } from './absence';
import { urgentAction } from './action-purpose';
import { strandedAt, withinReach } from './areas';
import { Blocked } from './blocked';
import { chaosOf } from './chaos';
import { fightConfidence, strikesFromAfar } from './fight-confidence';
import { Ambushed, type FighterContext, observedThreat } from './fighter-context';
import { combatSkill, fightCost, goldOf, teaches } from './fighter-prey';
import { type Gate, nearestGate } from './gates';
import { haven, onHaven, prefersHaven } from './haven';
import { travelJourney } from './journey';
import { travelByMoongate } from './moongate';
import { distance } from './navigation';
import { canBeat, selfState } from './self-state';
import { spawnGrounds as buildGrounds } from './spawn-grounds';
import { residentsNear } from './spread';
import { learnedPlaceCost } from './strategy-learning';
import { placeAllowed } from './towns';

// Trammel cemeteries (uo.com "Cemeteries" list) that hold undead spawners on the pinned shard
// (Spawns/trammel.xml Graveyards#0-#5). Nujel'm has no undead spawner and is not listed.
// `gate` is the public moongate a fighter travels through when the cemetery is far away.
export interface Ground {
  name: string;
  center: { x: number; y: number };
  gate: Gate;
  patrol?: { x: number; y: number }[];
  // Overland spawns (spawn-grounds.ts): how far they reach and what lives there.
  radius?: number;
  creatures?: Record<string, number>;
}
const cemeteryPlaces: Ground[] = [
  {
    name: 'Britain',
    center: { x: 1369, y: 1475 },
    gate: 'britain',
    patrol: [
      { x: 1375, y: 1485 },
      { x: 1355, y: 1475 },
      { x: 1375, y: 1455 },
      { x: 1395, y: 1475 }
    ]
  },
  { name: 'Vesper', center: { x: 2758, y: 867 }, gate: 'minoc' },
  { name: 'Yew', center: { x: 722, y: 1119 }, gate: 'yew' },
  { name: 'Jhelom', center: { x: 1285, y: 3731 }, gate: 'jhelom' },
  { name: 'Moonglow', center: { x: 4545, y: 1317 }, gate: 'moonglow' },
  // Liches spawn here; the opponent gate keeps ordinary fighters away from them.
  { name: 'Cove', center: { x: 2438, y: 1099 }, gate: 'minoc' },
  // The undead of Old Haven on Haven Island, where New Haven's residents start (haven.ts).
  { name: 'New Haven', center: { x: 3650, y: 2510 }, gate: 'newhaven' }
];
export const cemeteries: Ground[] = cemeteryPlaces.map((ground) => ({ ...ground }));
export const HUNTING_RADIUS = 65;
// The cemeteries, and every overland place where creatures that attack on sight spawn outside towns
// and dungeons (orcs, harpies, trolls and lizardmen west of Britain, and hundreds more), and Haven
// Island's: all from the shard's own spawners, read at start (shard-world.ts). A fighter moves on to
// one its skills meet when its cemetery runs dry.
export const grounds: Ground[] = [];
export function useShardSpawns(world: { spawners: Spawner[]; regions: Rect[] }) {
  const built = buildGrounds(world.spawners, world.regions, cemeteryPlaces, HUNTING_RADIUS);
  for (const cemetery of cemeteries) cemetery.creatures = built.cemeteries[cemetery.name];
  const overland = built.grounds.map((g) => ({ ...g, gate: nearestGate(g.center) }));
  const island = haven.grounds.map((g) => ({ ...g, gate: 'newhaven' as const }));
  // A cemetery with no spawner of its own on this shard has nothing to hunt: it is no ground.
  const spawning = cemeteries.filter((cemetery) => cemetery.creatures);
  grounds.splice(0, grounds.length, ...spawning, ...overland, ...island);
}
const reach = (ground: Ground) => ground.radius ?? HUNTING_RADIUS;
// Residents at a cemetery beyond which a fighter moving on looks elsewhere.
// Farther than this, a route is taken through a moongate instead of walked.

// A stranded fighter hunts where it stands (areas.ts): a ground named after its spot.
const LOCAL = 'where I am stranded near ';
export const groundOf = (trip: FighterContext['trip']): Ground => {
  if (trip.ground?.startsWith(LOCAL)) {
    const [x = 0, y = 0] = trip.ground.slice(LOCAL.length).split(',').map(Number);
    return { name: trip.ground, center: { x, y }, gate: nearestGate({ x, y }), radius: 16 };
  }
  return grounds.find((ground) => ground.name === trip.ground) ?? (cemeteries[0] as Ground);
};

export const nearAnyGround = (point: { x: number; y: number }) =>
  grounds.some((ground) => distance(point, ground.center) < reach(ground));

export const atGround = (ctx: FighterContext) =>
  distance(ctx.position(), groundOf(ctx.trip).center) < reach(groundOf(ctx.trip));

// Four points around the ground's centre, wider on an overland spawn than in a cemetery.
export const patrolPoints = (ground: Ground) => {
  const scale = ground.radius ? ground.radius / 16 : 1;
  return (
    ground.patrol ??
    [
      [6, 10],
      [-10, 0],
      [6, -10],
      [10, 0]
    ].map(([dx, dy]) => ({
      x: ground.center.x + Math.round((dx ?? 0) * scale),
      y: ground.center.y + Math.round((dy ?? 0) * scale)
    }))
  );
};

// Access and spawn data decide which grounds exist; relative danger affects their score.
export function groundFits(_ctx: FighterContext, ground: Ground): boolean {
  // Only around the cities the shard allows (gemwright.json ai.cities).
  if (!ground.name.startsWith(LOCAL) && !placeAllowed(ground.center)) return false;
  return (
    !ground.creatures ||
    Object.keys(ground.creatures).some((type) =>
      monsters.some((monster) => monster.type === type && monster.aggressive)
    )
  );
}

// `onFoot`: a gate just failed it, so only grounds it can walk to from here, when there are any.
export function nextGround(ctx: FighterContext, onFoot = false, includeCurrent = false): string {
  const here = ctx.position();
  const current = groundOf(ctx.trip).name;
  // The skill it fights with, not its highest: a maxed Anatomy says nothing about its sword arm.
  const skill = combatSkill(ctx);
  // A Young resident of New Haven prefers Haven Island's grounds (haven.ts), as new players do.
  const young = prefersHaven(ctx.session);
  const options = grounds.flatMap((ground) => {
    const present = residentsNear(ground.center, reach(ground), ctx.serial);
    if ((!includeCurrent && ground.name === current) || absence(ctx.serial).seen('ground', ground.center)) return [];
    // Where residents' walks keep failing or residents keep dying (trouble.ts) is not chosen until
    // the reports expire.
    if (keepsFailing(ground.center)) return [];
    // Only grounds it can walk to, or reach through a moongate (areas.ts): never one out at sea.
    if (!withinReach(here, ground.center)) return [];
    if (!groundFits(ctx, ground)) return [];
    const kinds = Object.entries(ground.creatures ?? {});
    const total = kinds.reduce((n, [, count]) => n + count, 0);
    const gold = kinds.reduce((n, [type, count]) => n + goldOf(type) * count, 0) / Math.max(1, total);
    // Skill comes from creatures near the character's own skill: a ground where most of them still
    // teach is worth up to 400 tiles more walking; gold only breaks ties.
    const teaching = kinds.filter(([type]) => teaches(ctx, type)).reduce((n, [, count]) => n + count, 0);
    const expectedLoss = Math.sqrt(
      kinds.reduce((sum, [type, count]) => sum + count * fightCost(ctx, type) ** 2, 0) / Math.max(1, total)
    );
    const pressure = expectedLoss * (1 + Math.sqrt(total) / (1 + reach(ground) / 16));
    const cost =
      pressure * 1000 +
      distance(here, ground.center) +
      learnedPlaceCost(ctx.checkpoint, ctx.session.world.map ?? 1, ground.center) +
      (ground.creatures ? 0 : Math.max(0, skill - 60) * 8) +
      present * 40 -
      (total ? (teaching / total) * 400 : 0) -
      Math.min(gold, 100) +
      Math.random() * 300 * chaosOf(ctx.session) +
      (young && !onHaven(ground.center) ? 300 : 0);
    return [{ name: ground.name, cost, center: ground.center }];
  });
  const walkable = options.filter((option) => distance(here, option.center) <= WALKING_LIMIT);
  return (
    (onFoot && walkable.length ? walkable : options).sort((a, b) => a.cost - b.cost)[0]?.name ??
    (young ? 'New Haven' : 'Britain')
  );
}

// Navigation owns walking legs, connected areas and transit.
export async function travelNear(ctx: FighterContext, point: { x: number; y: number }, range: number) {
  await ctx.navigate(point, range);
}

export async function travelToGround(ctx: FighterContext) {
  // Stranded (no moongate in its walkable area): it hunts right here until help moves it; once
  // out, a real ground again.
  const here = ctx.position();
  // First a way out, as a player would (Recall, else the stuck menu; moongate.ts), every half hour.
  const way = lasting('stranded-escape', ctx.serial);
  if (strandedAt(here) && !way.active('next')) {
    way.set('next', Date.now() + 30 * 60_000);
    await travelByMoongate(ctx, nearestGate(here)).catch(() => {});
  }
  if (strandedAt(ctx.position())) {
    ctx.trip.ground = `${LOCAL}${here.x},${here.y}`;
    ctx.persist();
    ctx.phase('stranded-hunting', 'No way out on foot; hunting where I stand');
    return;
  }
  // A ground chosen before (a saved trip) is held to the same test as a new choice.
  const selected = nextGround(ctx, false, true);
  if (ctx.trip.ground !== selected) {
    ctx.trip.ground = selected;
    ctx.persist();
  }
  const ground = groundOf(ctx.trip);
  ctx.phase(
    'travelling-to-graveyard',
    `Heading to ${ground.creatures ? `the ${ground.name}` : `the ${ground.name} cemetery`}`
  );
  try {
    await ctx.navigate(ground.center, 3);
  } catch (error) {
    if (error instanceof Blocked && (error.reason === 'unreachable' || error.reason === 'dangerous')) {
      absence(ctx.serial).note('ground', ground.center);
      ctx.trip.ground = nextGround(ctx);
      ctx.persist();
      ctx.log(`Cannot reach the ${ground.name}; hunting at the ${groundOf(ctx.trip).name} instead`);
    }
    throw error;
  }
}

// Town trips (bank, vendors, healer) go to the nearest town with a fighter's services (towns.ts).
// The way there is itself the escape: being hit on the way must not cancel it (fighter.ts check()
// retreats on damage outside combat, which would restart this trip on every step).
export async function returnToNearestTown(ctx: FighterContext) {
  await urgentAction(ctx.session, 'escape', () => travelJourney(ctx, ctx.services.bank, 4, ctx.escapeNavigate));
}

// What is swinging at it first (the server's swing packet names attacker and target), else the
// nearest threat within 8 tiles (fighter.ts check).
const attackerNear = (ctx: FighterContext) => {
  const swinging = ctx
    .nearby()
    .find(
      (m) =>
        !ctx.session.world.deaths.has(m.serial) &&
        ctx.session.world.swings.get(m.serial)?.target === ctx.serial &&
        Date.now() - (ctx.session.world.swings.get(m.serial)?.at ?? 0) < 3000
    );
  if (swinging) return { mobile: swinging, engaged: true };
  const near = ctx
    .nearby()
    .filter(
      (m) =>
        m.position &&
        !ctx.session.world.deaths.has(m.serial) &&
        observedThreat(m, ctx.session.world.combatant) &&
        distance(ctx.position(), m.position) < 8
    )
    .sort(
      (a, b) =>
        distance(ctx.position(), a.position ?? ctx.position()) - distance(ctx.position(), b.position ?? ctx.position())
    )[0];
  if (near) return { mobile: near, engaged: false };
  // Nothing swings and nothing is close: a caster or archer in sight is what hurts it.
  const afar = ctx
    .nearby()
    .filter(
      (m) =>
        m.position &&
        !ctx.session.world.deaths.has(m.serial) &&
        observedThreat(m, ctx.session.world.combatant) &&
        strikesFromAfar(m) &&
        distance(ctx.position(), m.position) <= 14
    )
    .sort(
      (a, b) =>
        distance(ctx.position(), a.position ?? ctx.position()) - distance(ctx.position(), b.position ?? ctx.position())
    )[0];
  return afar && { mobile: afar, engaged: true };
};

// Hurt twice within half an hour on the same ground: it is beyond it for now, so another one.
export function retreatedFrom(ctx: FighterContext) {
  ctx.log(
    `Withdrew from ${groundOf(ctx.trip).name}; reassessing the observed encounter rather than banning its creature types`
  );
}

// Hurt outside a fight: it turns on the attacker when it expects to walk away (fight-confidence.ts),
// otherwise it gets to safety.
export function hurtOnTheWay(ctx: FighterContext) {
  const attacker = attackerNear(ctx);
  // One it can beat is fought back by the combat tick (reflex.ts), never run from.
  const self = selfState(ctx.session, ctx.dead());
  if (self.attackers.some((mobile) => canBeat(ctx.session, self, mobile))) return;
  if (attacker && !ctx.state.inCombat && fightConfidence(ctx, attacker.mobile).ok) throw new Ambushed(attacker.mobile);
  // Anything else is the combat tick's to answer (reflex.ts): it flees from what it cannot beat, and
  // from unseen harm once it starts to tell, as an escape no hit cancels. A retreat thrown here was
  // cancelled by the next hit on its own first step, and the fighter stood still until it died.
}

// Attacked on the way (hurtOnTheWay): it fights the attacker now, wherever this is. True when it did.
export async function fightBack(
  ctx: FighterContext,
  attacker: Ambushed['attacker'] | undefined,
  defeat: (opponent: Ambushed['attacker']) => Promise<void>
) {
  if (!attacker || !ctx.session.world.entities.has(attacker.serial) || ctx.session.world.deaths.has(attacker.serial))
    return false;
  ctx.phase('fighting-back', `Attacked on the way; fighting ${attacker.name ?? 'the attacker'}`);
  await defeat(attacker);
  return true;
}
