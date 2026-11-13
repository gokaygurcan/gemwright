import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { skillNames } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';
import type { WorldView } from '@gemwright/network/world';
import type { JournalEntry } from '@gemwright/network/world-types';

import { selfProjection } from '../perception-self';
import { decodeOut, OUT } from '../recording';
import type { Place } from './atlas';
import type { HistoryEvent } from './history';
import { identify, identifyVendor } from './knowledge';

// The live screen, read-only: what the hands that act on it see (hands.ts and the other doers),
// and the only way past perception to the world. Choosing reads the mind, never this.
export type Screen = Readonly<WorldView>;
export const screenOf = (session: PlayerSession): Screen => session.world;

const facts = [
  'graphic',
  'name',
  'notoriety',
  'hue',
  'amount',
  'layer',
  'flags',
  'parent',
  'hits',
  'maxHits',
  'x',
  'y',
  'z'
] as const;
// What the client sends on its own, not anything the player does.
const housekeeping = new Set([
  'create-character',
  'play-character',
  'account-login',
  'game-login',
  'select-server',
  'login-seed',
  'client-version',
  'update-range',
  'ping',
  'resync',
  'status-request',
  'tooltip-request'
]);
type Facts = Partial<Record<(typeof facts)[number], number | string>>;

// What a player sees on screen, recorded as it changes: the resident's own state, the things and
// creatures in view, what it owns, what it hears, and what happens. The only reader of the world.
export function perceive(
  session: PlayerSession,
  resident: string,
  sink: (event: HistoryEvent) => void,
  // The land tile at a spot of a map, as the client draws it from the map files.
  landAt: (x: number, y: number, map: number | null) => number | undefined = () => undefined,
  // Where a spot is on the map (atlas.ts).
  placeAt?: (p: { x: number; y: number; z: number; map: number | null }) => Place
): () => void {
  const world = session.world;
  const known = new Map<number, { facts: Facts; owned: boolean; shown?: string }>();
  const sheet = (s: { value: number; base: number; cap: number; lock: number }) =>
    `${s.value},${s.base},${s.cap},${s.lock}`;
  const skills = new Map([...world.skills].map(([id, s]) => [id, s.value]));
  const sheets = new Map([...world.skills].map(([id, s]) => [id, sheet(s)]));
  const { position: _, range: __, ...initial } = selfProjection(world);
  let self = JSON.stringify(initial);
  let heard: JournalEntry | undefined = world.journal.at(-1);
  // Windows and marks on screen, each kept as last recorded: gumps, vendor lists, damage numbers.
  const shown = new Map<string, string>();
  const vendors = new Map<number, string>();
  const ghostly = () => GHOST_BODIES.has(world.entities.get(world.serial ?? -1)?.graphic ?? 0);
  let ghost = ghostly();
  const animated = new Map<number, number>();
  const show = (kind: string, entries: Iterable<[number | string, unknown]>) => {
    const open = new Set<string>();
    for (const [key, value] of entries) {
      const id = `${kind}:${key}`;
      const text = JSON.stringify(value);
      open.add(id);
      if (shown.get(id) !== text) record(kind, { key, value });
      shown.set(id, text);
    }
    for (const id of shown.keys())
      if (id.startsWith(`${kind}:`) && !open.has(id)) {
        shown.delete(id);
        record(`${kind}-closed`, { key: id.slice(kind.length + 1) });
      }
  };

  // Where it stands, known at every step: recorded whenever the place changes.
  let tile: string | undefined;
  let place: string | undefined;
  const locate = () => {
    const p = world.position;
    if (!p || !placeAt) return;
    const at = `${p.x},${p.y},${p.z},${world.map}`;
    if (at === tile) return;
    tile = at;
    const found = placeAt({ ...p, map: world.map });
    // From one level of a dungeon to another: down to a deeper one, or up.
    const before = place === undefined ? undefined : (JSON.parse(place) as Place);
    const now: Place =
      before?.dungeon && before.dungeon === found.dungeon && before.level && found.level && before.level !== found.level
        ? { ...found, came: found.level > before.level ? 'down' : 'up' }
        : before?.dungeon === found.dungeon && before?.level === found.level && before?.came
          ? { ...found, came: before.came }
          : found;
    const text = JSON.stringify(now);
    if (text !== place) record('place', now);
    place = text;
  };

  const record = (kind: string, data: object) => {
    const p = world.position;
    sink({
      resident,
      at: Date.now(),
      kind,
      data,
      ...(p ? { where: { x: p.x, y: p.y, z: p.z, map: world.map } } : {})
    });
  };
  const owned = (serial: number) => {
    for (let at = world.entities.get(serial)?.parent, hops = 0; at !== undefined && hops < 16; hops++) {
      if (at === world.serial) return true;
      at = world.entities.get(at)?.parent;
    }
    return false;
  };
  // In its bank box (the Bank layer), or the box itself: always its own, only ever shown.
  const banked = (serial: number) => {
    for (let at: number | undefined = serial, hops = 0; at !== undefined && hops < 16; hops++) {
      const entity = world.entities.get(at);
      if (entity?.layer === Layer.Bank && entity.parent === world.serial) return true;
      at = entity?.parent;
    }
    return false;
  };
  // `revealing`: what it already had, shown when it wakes or opens a container, not gained now.
  const read = (serial: number, opening = false) => {
    const revealing = opening || banked(serial);
    const entity = world.entities.get(serial);
    if (!entity || serial === world.serial) return;
    const mine = owned(serial);
    const now: Facts = {};
    const seen = { ...entity, ...entity.position };
    for (const key of facts) if (seen[key] !== undefined) now[key] = seen[key];
    const before = known.get(serial);
    known.set(serial, { facts: now, owned: mine });
    if (!before || before.owned !== mine)
      return record(mine ? (revealing ? 'revealed' : 'gained') : 'seen', {
        serial,
        kind: entity.kind,
        ...now,
        is: identify(entity),
        ...(entity.properties ? { properties: entity.properties } : {})
      });
    const changed: Record<string, unknown> = Object.fromEntries(
      facts.filter((k) => now[k] !== before.facts[k]).map((k) => [k, now[k]])
    );
    // Its hover (what a player sees on mouse-over), when it arrives or changes.
    const shown = entity.properties && JSON.stringify(entity.properties);
    if (shown && shown !== before.shown) changed.properties = entity.properties;
    known.set(serial, { facts: now, owned: mine, shown: shown ?? before.shown });
    if ('name' in changed || 'graphic' in changed || 'hue' in changed || 'properties' in changed)
      changed.is = identify(entity);
    if (Object.keys(changed).length) record('changed', { serial, ...changed });
  };

  const unsubscribe = world.observations.subscribe(
    (change) => {
      // Its own body: a ghost's after death, a living one again once resurrected.
      if (change.entities.includes(world.serial ?? -1)) {
        const now = ghostly();
        if (ghost && !now) record('revived', {});
        ghost = now;
      }
      if (change.fields.length || change.entities.includes(world.serial ?? -1)) {
        const { position: _, range: __, ...now } = selfProjection(world);
        const next = JSON.stringify(now);
        if (next !== self) {
          const before = JSON.parse(self) as Record<string, unknown>;
          record(
            'self',
            Object.fromEntries(Object.entries(now).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])))
          );
          self = next;
        }
      }
      for (const id of change.skills) {
        const now = world.skills.get(id);
        if (!now || sheet(now) === sheets.get(id)) continue;
        record('skill', {
          skill: skillNames[id] ?? id,
          value: now.value,
          before: skills.get(id) ?? null,
          base: now.base,
          cap: now.cap,
          lock: now.lock
        });
        skills.set(id, now.value);
        sheets.set(id, sheet(now));
      }
      for (const serial of change.entities) read(serial, change.opcode === 0x3c);
      // An opened container shows all it holds: what is not listed is no longer in it.
      if (change.opcode === 0x3c)
        for (const parent of new Set(world.lastContainerContents.map((serial) => world.entities.get(serial)?.parent)))
          if (parent !== undefined)
            record('listed', { serial: parent, contents: [...world.entities.childSerials(parent)] });
      for (const serial of change.removed) {
        const before = known.get(serial);
        if (!before) continue;
        known.delete(serial);
        record(before.owned ? 'lost' : 'gone', { serial, ...before.facts });
      }
      for (const event of change.events)
        if (event.type === 'self-death') record('died', {});
        else if (event.type === 'entity-death') record('death', { serial: event.serial, corpse: event.corpse });
        else if (event.type === 'movement-rejected') record('blocked', {});
        else record('swing', { attacker: event.attacker, target: event.target });
      const journal = world.journal;
      const from = heard ? journal.lastIndexOf(heard) + 1 : 0;
      for (const line of journal.slice(from))
        record('heard', {
          serial: line.serial,
          name: line.name,
          ...(line.text !== undefined ? { text: line.text } : {}),
          ...(line.cliloc !== undefined ? { cliloc: line.cliloc, arguments: line.arguments } : {}),
          ...(line.type !== undefined ? { type: line.type } : {}),
          ...(line.party ? { party: true } : {})
        });
      heard = journal.at(-1);
      show('screen', [
        ['cursor', world.target],
        ['combatant', world.combatant],
        ['war', world.warMode],
        ['trade', world.trade?.closed === false ? world.trade : null]
      ]);
      show('gump', world.gumps);
      show('buy', world.buyOffers);
      // A buy list's goods tell what kind of vendor stands behind it.
      for (const [stock, offers] of world.buyOffers) {
        const vendor = world.entities.get(stock)?.parent;
        if (vendor === undefined) continue;
        const is = identifyVendor(offers.flatMap((o) => world.entities.get(o.serial)?.graphic ?? []));
        if (!is.length || vendors.get(vendor) === is.join('/')) continue;
        vendors.set(vendor, is.join('/'));
        record('changed', { serial: vendor, is });
      }
      show('sell', world.sellOffers);
      locate();
      show('damage', world.damage);
      // Every action a mobile in view plays: swings, casts, bows (the client's animations).
      for (const [serial, animation] of world.animations)
        if ((animated.get(serial) ?? 0) < animation.at) {
          animated.set(serial, animation.at);
          record('animated', { serial, type: animation.type, action: animation.action });
        }
    },
    (error) => record('perception-failed', { reason: error instanceof Error ? error.message : String(error) })
  );

  // What it does: every verb its client sends, as a player's hands on mouse and keyboard.
  const tap = session.tap;
  session.tap = (direction, packet) => {
    tap?.(direction, packet);
    const verb = direction === 'out' ? OUT[packet[0] ?? -1] : undefined;
    if (!verb || housekeeping.has(verb)) return;
    const decoded = decodeOut(packet);
    // Targeting the land itself names no graphic: the map shows what land it is.
    const land =
      verb === 'target' && decoded?.serial === 0 && !decoded.graphic && decoded.x !== 0xffff
        ? landAt(decoded.x as number, decoded.y as number, world.map)
        : undefined;
    record('acted', { verb, ...decoded, ...(land === undefined ? {} : { land }) });
  };

  record('awake', {
    serial: world.serial,
    ghost,
    self: initial,
    skills: Object.fromEntries([...skills].map(([id, v]) => [skillNames[id] ?? id, v])),
    // Every skill as its sheet shows it: value, base, cap and lock (0 up, 1 down, 2 locked).
    sheet: Object.fromEntries(
      [...world.skills].map(([id, s]) => [
        skillNames[id] ?? id,
        { value: s.value, base: s.base, cap: s.cap, lock: s.lock }
      ])
    )
  });
  locate();
  const protection = world.journal.findLast((line) => line.cliloc === 500112 || line.cliloc === 500113);
  if (protection) record('heard', { serial: protection.serial, name: protection.name, cliloc: protection.cliloc });
  for (const serial of world.entities.keys()) read(serial, true);
  return () => {
    unsubscribe();
    session.tap = tap;
    record('asleep', {});
  };
}
