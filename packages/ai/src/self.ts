import { readFileSync } from 'node:fs';

import {
  bandage,
  fishingPoles,
  gold,
  hatchets,
  healPotion,
  instruments,
  miningTools,
  sewingKit
} from '@gemwright/common/items';
import { skillId, skillNames } from '@gemwright/common/skills';

import { knownBankGold } from './bank-gold';
import type { CharacterTemplate } from './config';
import { meleeWeapons, weaponSkill, weaponsFor } from './fighter-context';
import { quality } from './item-quality';
import { lasting } from './lasting';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { equippedRanged } from './ranged-weapons';
import type { Checkpoint } from './store';
import { professionOf } from './world';

// Who a resident is and what it has, as it would know it: its build and skills, what it wears
// and carries, what it last saw in its bank box, its gold, and from these what it is worth, what
// a death would cost and how strong it is. Every choice that weighs a risk reads this (fight
// confidence, Jev's decision state), so better gear makes a resident bolder and a full pack more
// careful, without rules spelled out for each case.
// The one goal every resident lives by, from its own trade, gear and skills (ROADMAP.md).
export const LIFE_GOAL = 'Grow stronger and richer through your trade, without dying.';

const prices = new Map(
  (
    JSON.parse(readFileSync(new URL('../catalogs/prices.json', import.meta.url), 'utf8')) as {
      items: { graphic: number; type: string; buy: number }[];
    }
  ).items.map((i) => [i.graphic, i])
);
// Most items have two facings, one graphic apart; the vendor list names one.
const priceOf = (graphic: number) => prices.get(graphic) ?? prices.get(graphic - 1) ?? prices.get(graphic + 1);
const ARMOR = /Plate|Chain|Ring|Leather|Studded|Bone|Helm|Gorget|Shield|Bascinet|Coif|Buckler|Gauntlet|Bracelet|Tunic/;
const ARMOR_LAYERS = [Layer.Helm, Layer.Neck, Layer.InnerTorso, Layer.Arms, Layer.Gloves, Layer.Pants];

// An item's worth as a replacement: the shop price, more for exceptional, coloured metal or magic.
export function worth(item: Pick<Entity, 'graphic' | 'amount' | 'hue' | 'properties'>) {
  if (item.graphic === gold) return item.amount ?? 1;
  const base = priceOf(item.graphic)?.buy ?? 5;
  const q = quality(item as Entity);
  const factor =
    q === 'artifact' ? 20 : q === 'magic' || q === 'blessed' ? 5 : q === 'exceptional' ? 1.5 : item.hue ? 1.5 : 1;
  return Math.round(base * factor * (item.amount ?? 1));
}
export const isArmor = (graphic: number) => ARMOR.test(priceOf(graphic)?.type ?? '');
export const itemName = (graphic: number) =>
  (priceOf(graphic)?.type ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() || undefined;

// What a mobile wears (its equipment as the server shows it to everyone): weapon, armour, mount.
export function wornBy(session: PlayerSession, serial: number) {
  const worn = session.world
    .childrenOf(serial)
    .filter((i) => i.layer !== undefined && i.layer !== Layer.Backpack && i.layer !== Layer.Bank);
  const weapon = worn.find(
    (i) => (i.layer === Layer.OneHanded || i.layer === Layer.TwoHanded) && !isArmor(i.graphic) && !!priceOf(i.graphic)
  );
  const armor = worn.filter((i) => isArmor(i.graphic));
  const covered = ARMOR_LAYERS.filter((layer) => armor.some((i) => i.layer === layer)).length;
  return {
    worn,
    weapon,
    armor,
    shield: armor.some((i) => i.layer === Layer.TwoHanded),
    // Share of the body armour covers (helm, gorget, chest, arms, gloves, legs).
    coverage: covered / ARMOR_LAYERS.length,
    mounted: worn.some((i) => i.layer === Layer.Mount),
    value: worn.reduce((n, i) => n + worth(i), 0)
  };
}

const inside = (session: PlayerSession, container: number): Entity[] =>
  session.world.childrenOf(container).flatMap((i) => [i, ...inside(session, i.serial)]);

export interface SelfImage {
  at: string;
  goal: string;
  name?: string;
  trade: string;
  archetype?: string;
  skills: { name: string; value: number }[];
  skillTotal: number;
  combatSkill: { name: string; value: number };
  stats: { str: number; dex: number; int: number };
  health: number;
  weapon?: { name?: string; ownKind: boolean; worth: number };
  armor: { pieces: number; coverage: number; shield: boolean; worth: number; rating: number };
  carried: { gold: number; worth: number; healing: number; items: number };
  bank: { gold: number; worth: number; seenAt?: string };
  // Gold and goods in all; what a death now would lose (worn and carried); how strong it is in a
  // fight, 0-1 (combat skill, weapon, armour); recent deaths.
  wealth: number;
  atRisk: number;
  power: number;
  deathsLastHour: number;
}

// Looks at itself: called each turn (cheap), kept in the checkpoint for decisions and reports.
export function selfImage(session: PlayerSession, checkpoint: Checkpoint, template: CharacterTemplate): SelfImage {
  const serial = session.world.serial ?? 0;
  const me = session.world.entities.get(serial);
  const status = session.world.status;
  // Read through the parent index: cheap enough for every tick.
  const own = session.world.childrenOf(serial);
  const pack = own.find((i) => i.layer === Layer.Backpack);
  const carried = pack ? inside(session, pack.serial) : [];
  // The bank box's contents are seen only while it is open; the last look is kept.
  const box = own.find((i) => i.layer === Layer.Bank);
  const banked = box ? inside(session, box.serial) : [];
  if (banked.length)
    checkpoint.bankSeen = {
      at: new Date().toISOString(),
      items: banked.length,
      worth: banked.filter((i) => i.graphic !== gold).reduce((n, i) => n + worth(i), 0)
    };
  const gear = wornBy(session, serial);
  const skill = (name: string) => session.world.skills.get(skillId(name))?.value ?? 0;
  const fighting = weaponSkill(template);
  const ownKind = weaponsFor(template);
  const skills = [...session.world.skills]
    .map(([id, s]) => ({ name: skillNames[id] ?? String(id), value: s.value }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  const carriedGold =
    status?.gold ?? carried.filter((i) => i.graphic === gold).reduce((n, i) => n + (i.amount ?? 1), 0);
  const carriedWorth = carried.filter((i) => i.graphic !== gold).reduce((n, i) => n + worth(i), 0);
  const bankGold = knownBankGold(checkpoint);
  const bankWorth = checkpoint.bankSeen?.worth ?? 0;
  const weaponFactor = gear.weapon
    ? ownKind.has(gear.weapon.graphic)
      ? 1
      : 0.7
    : fighting === 'Wrestling'
      ? 0.6
      : 0.3;
  const power = Math.min(
    1,
    (skill(fighting) / 100) * weaponFactor * (0.55 + 0.45 * gear.coverage) +
      (gear.shield ? 0.05 : 0) +
      Math.min(0.1, (skill('Healing') / 100) * 0.1)
  );
  const image: SelfImage = {
    at: new Date().toISOString(),
    goal: LIFE_GOAL,
    name: me?.name,
    trade: template.id,
    archetype: template.archetype?.id,
    skills: skills.slice(0, 8),
    skillTotal: Math.round(skills.reduce((n, s) => n + s.value, 0) * 10) / 10,
    combatSkill: { name: fighting, value: skill(fighting) },
    stats: { str: status?.strength ?? 0, dex: status?.dexterity ?? 0, int: status?.intelligence ?? 0 },
    health: status ? Math.round((status.hits / Math.max(1, status.maxHits)) * 100) / 100 : 1,
    weapon: gear.weapon && {
      name: itemName(gear.weapon.graphic),
      ownKind: ownKind.has(gear.weapon.graphic),
      worth: worth(gear.weapon)
    },
    armor: {
      pieces: gear.armor.length,
      coverage: Math.round(gear.coverage * 100) / 100,
      shield: gear.shield,
      worth: gear.armor.reduce((n, i) => n + worth(i), 0),
      rating: status?.armor ?? 0
    },
    carried: {
      gold: carriedGold,
      worth: carriedWorth,
      healing: carried
        .filter((i) => i.graphic === bandage || i.graphic === healPotion)
        .reduce((n, i) => n + (i.amount ?? 1), 0),
      items: carried.length
    },
    bank: { gold: bankGold, worth: bankWorth, seenAt: checkpoint.bankSeen?.at },
    wealth: carriedGold + carriedWorth + gear.value + bankGold + bankWorth,
    atRisk: carriedGold + carriedWorth + gear.value,
    power: Math.round(power * 100) / 100,
    deathsLastHour: lasting('deaths', serial).count()
  };
  checkpoint.self = image;
  return image;
}

// The image in a player's words, for its own log and for anyone who asks how it is doing.
export function describeSelf(image: SelfImage) {
  const weapon = image.weapon
    ? `${image.weapon.name ?? 'a weapon'}${image.weapon.ownKind ? '' : ' (not my kind)'}`
    : 'no weapon';
  const armor = image.armor.pieces ? `${image.armor.pieces} pieces of armour` : 'no armour';
  return `${image.combatSkill.name} ${image.combatSkill.value.toFixed(1)}, ${weapon}, ${armor}; ${image.wealth.toLocaleString('en-GB')} gold in all, ${image.atRisk.toLocaleString('en-GB')} of it on me`;
}

// The live view: what its client shows right now, worked out again only when the client's state
// has changed (the world revision), so every tick reads the truth at no extra cost.
const seen = new WeakMap<object, { revision: number; image: SelfImage }>();
export function selfNow(session: PlayerSession, checkpoint: Checkpoint, template: CharacterTemplate): SelfImage {
  const cached = seen.get(session);
  if (cached && cached.revision === session.world.revision) return cached.image;
  const image = selfImage(session, checkpoint, template);
  seen.set(session, { revision: session.world.revision, image });
  return image;
}

// Whether it can do its trade right now, from the one live view; what it lacks and roughly what
// that costs. One definition for every part of its behaviour.
export function jobReady(session: PlayerSession, template: CharacterTemplate) {
  const serial = session.world.serial ?? -1;
  const pack = session.world.childrenOf(serial).find((i) => i.layer === Layer.Backpack);
  const owned = [...session.world.childrenOf(serial), ...(pack ? inside(session, pack.serial) : [])];
  const has = (set: ReadonlySet<number> | number) =>
    owned.some((i) => (typeof set === 'number' ? i.graphic === set : set.has(i.graphic)));
  const trade = professionOf(template.id)?.[0] ?? template.archetype?.id ?? '';
  const needs = (ok: boolean, what: string, price: number) =>
    ok ? { ready: true as const } : { ready: false as const, what, price };
  if (template.behavior.activities.includes('mine')) return needs(has(miningTools), 'a pickaxe or a shovel', 40);
  if (template.behavior.activities.includes('chop')) return needs(has(hatchets), 'a hatchet', 30);
  if (trade === 'fisherman' || trade === 'fisher') return needs(has(fishingPoles), 'a fishing pole', 20);
  if (trade === 'bard') return needs(has(instruments), 'an instrument', 35);
  if (trade === 'tailor') return needs(has(sewingKit), 'a sewing kit', 5);
  if (trade === 'alchemist') return needs(has(0x0e9b), 'a mortar and pestle', 8);
  if (trade === 'bowyer') return needs(has(new Set([0x1022, 0x1023])), 'fletching tools', 4);
  if (template.behavior.activities.includes('hunt')) {
    const family = weaponSkill(template);
    // Casters and wrestlers fight without one; archers need a bow; anyone else any melee weapon.
    if (family === 'Wrestling' || template.archetype?.primarySkills.includes('Magery')) return { ready: true as const };
    if (family === 'Archery') return needs(!!equippedRanged(session) || has(weaponsFor(template)), 'a bow', 50);
    return needs(has(meleeWeapons), 'a weapon', 35);
  }
  // Tamers, thieves and the rest need nothing to work.
  return { ready: true as const };
}

// Opens the backpack and waits for its contents, so the live view has seen what is in it.
export async function observeBackpack(session: PlayerSession) {
  const pack = session.world.childrenOf(session.world.serial ?? -1).find((i) => i.layer === Layer.Backpack);
  if (!pack) return;
  const before = session.world.received.get(0x3c) ?? 0;
  session.use(pack.serial);
  await session
    .waitFor(() => (session.world.received.get(0x3c) ?? 0) > before, 'backpack contents', 4000)
    .catch(() => {});
}
