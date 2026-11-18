import type { PlayerSession } from '@gemwright/network/session';

import { identify } from '../../src/knowledge';
import { Mind } from '../../src/mind';
import { traitsOf } from '../../src/traits';

type Entity = {
  serial: number;
  kind?: string;
  graphic?: number;
  hue?: number;
  amount?: number;
  parent?: number;
  layer?: number;
  name?: string;
  flags?: number;
  properties?: unknown[];
  position?: { x: number; y: number; z: number };
};
type Screen = {
  serial?: number | null;
  map?: number | null;
  position?: { x: number; y: number; z: number } | null;
  entities: Map<number, Entity>;
  status?: {
    weight?: number;
    maxWeight?: number;
    stamina?: number;
    maxStamina?: number;
    hits?: number;
    maxHits?: number;
  };
};

const synced = new WeakMap<Mind, Map<number, string>>();

// What perception (perceive.ts) would tell a mind of a hand-built screen: woken once, then each
// thing on it seen or shown as its own, and each thing gone from it lost or gone. Tests that build
// a screen by hand keep the mind in step with it through this, as the live mind is kept by
// perception.
export function syncMind(mind: Mind, screen: Screen) {
  const where = screen.position ? { where: { ...screen.position, map: screen.map ?? 1 } } : {};
  const observe = (kind: string, data: object) => mind.observe({ resident: 'r', at: Date.now(), kind, data, ...where });
  let known = synced.get(mind);
  if (!known) {
    known = new Map();
    synced.set(mind, known);
    if (mind.serial !== screen.serial) observe('awake', { serial: screen.serial, self: {} });
  }
  // Where it stands goes with every perception; a still screen still says so.
  if (!screen.status && screen.position) observe('self', {});
  if (screen.status) {
    const s = screen.status;
    observe('self', {
      ...(s.weight !== undefined && s.maxWeight !== undefined
        ? { weight: { current: s.weight, max: s.maxWeight } }
        : {}),
      ...(s.stamina !== undefined ? { stamina: { current: s.stamina, max: s.maxStamina ?? s.stamina } } : {}),
      ...(s.hits !== undefined ? { health: { current: s.hits, max: s.maxHits ?? s.hits } } : {})
    });
  }
  // A thing the mind was already told the name of keeps it; any other is named as perception would.
  const named = (serial: number) => {
    const name = mind.sight(serial)?.name;
    return name !== undefined && !/^g\d+$/.test(name);
  };
  const identity = (entity: Entity) =>
    entity.graphic === undefined
      ? []
      : identify({ ...entity, kind: entity.kind === 'mobile' ? 'mobile' : 'item', graphic: entity.graphic } as never);
  const owned = (serial: number) => {
    for (let at: number | undefined = serial, hops = 0; at !== undefined && hops < 16; hops++) {
      if (at === screen.serial) return true;
      at = screen.entities.get(at)?.parent;
    }
    return false;
  };
  for (const entity of screen.entities.values()) {
    if (entity.serial === screen.serial) continue;
    const facts = {
      serial: entity.serial,
      kind: entity.kind,
      ...(entity.graphic !== undefined ? { graphic: entity.graphic } : {}),
      ...(entity.hue !== undefined ? { hue: entity.hue } : {}),
      ...(entity.amount !== undefined ? { amount: entity.amount } : {}),
      ...(entity.parent !== undefined ? { parent: entity.parent } : {}),
      ...(entity.layer !== undefined ? { layer: entity.layer } : {}),
      ...(entity.flags !== undefined ? { flags: entity.flags } : {}),
      ...(entity.kind === 'mobile' && entity.name ? { name: entity.name } : {}),
      ...(entity.position ? entity.position : {}),
      ...(entity.properties ? { properties: entity.properties } : {})
    };
    const text = JSON.stringify([facts, owned(entity.serial)]);
    if (known.get(entity.serial) === text) continue;
    const before = known.get(entity.serial);
    known.set(entity.serial, text);
    const mine = owned(entity.serial);
    const name = named(entity.serial) ? mind.sight(entity.serial)?.name?.split('/') : undefined;
    const believed = mind.belongings().has(entity.serial) === mine;
    if ((before === undefined && !(name && believed)) || (before !== undefined && JSON.parse(before)[1] !== mine))
      observe(mine ? 'revealed' : 'seen', { ...facts, is: name ?? identity(entity) });
    else observe('changed', facts);
  }
  for (const [serial, text] of known)
    if (!screen.entities.has(serial)) {
      known.delete(serial);
      observe(JSON.parse(text)[1] ? 'lost' : 'gone', { serial });
    }
}

// A hand-built session whose every action is followed by what perception would tell the mind of it.
export function perceived<T extends object>(session: T, mind: Mind): T & PlayerSession {
  const screen = (session as unknown as { world: Screen }).world;
  syncMind(mind, screen);
  return new Proxy(session, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        if (result instanceof Promise)
          return result.then((answer) => {
            syncMind(mind, screen);
            return answer;
          });
        syncMind(mind, screen);
        return result;
      };
    }
  }) as T & PlayerSession;
}

// One mind for a hand-built session, kept for as long as the session is.
const minds = new WeakMap<object, Mind>();
export function mindFor(session: object) {
  let mind = minds.get(session);
  if (!mind) {
    mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
    minds.set(session, mind);
  }
  return mind;
}

// The mind as it stands after seeing a hand-built session's screen.
export function seeing(mind: Mind, session: object) {
  syncMind(mind, (session as { world: Screen }).world);
  return mind;
}
