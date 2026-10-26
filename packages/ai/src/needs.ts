import {
  arrow,
  bandage,
  fishingPoles,
  hatchets,
  healPotion,
  instruments,
  miningTools,
  reagents,
  sewingKit
} from '@gemwright/common/items';

import { knownBankGold } from './bank-gold';
import type { CharacterTemplate } from './config';
import type { ServiceType } from './locations';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import { equippedRanged, rangedWeapon } from './ranged-weapons';
import type { Checkpoint } from './store';
import { professionOf } from './world';

// What a resident is short of, from what it carries, its trade and its funds: the honest answer to
// "do you need anything?". Each need names the thing in a player's words and why it is wanted, so
// a player who brings it can see it was real.
export interface Need {
  what: string;
  why: string;
  kind?: 'tool' | 'supply' | 'income';
  purchase?: {
    service: ServiceType;
    graphics: number[];
    amount: number;
    maxPrice: number;
    wanted?: Record<number, number>;
  };
}

const LOW_FUNDS = 50;

function carried(session: PlayerSession): Map<number, number> {
  const counts = new Map<number, number>();
  const seen = new Set<number>();
  const visit = (parent: number) => {
    if (seen.has(parent)) return;
    seen.add(parent);
    for (const item of session.world.childrenOf(parent)) {
      if (item.layer === Layer.Bank) continue;
      counts.set(item.graphic, (counts.get(item.graphic) ?? 0) + (item.amount ?? 1));
      visit(item.serial);
    }
  };
  if (session.world.serial !== null && session.world.serial !== undefined) visit(session.world.serial);
  return counts;
}

export function residentNeeds(session: PlayerSession, checkpoint: Checkpoint, template: CharacterTemplate): Need[] {
  const counts = carried(session);
  const has = (graphics: ReadonlySet<number> | number) =>
    typeof graphics === 'number'
      ? (counts.get(graphics) ?? 0)
      : [...graphics].reduce((n, graphic) => n + (counts.get(graphic) ?? 0), 0);
  const profession = professionOf(template.id)?.[0] ?? template.archetype?.id ?? '';
  const needs: Need[] = [];
  const tool = (graphics: ReadonlySet<number> | number, what: string, service: ServiceType, maxPrice: number) => {
    if (!has(graphics))
      needs.push({
        what,
        why: 'I cannot work without one',
        kind: 'tool',
        purchase: { service, graphics: typeof graphics === 'number' ? [graphics] : [...graphics], amount: 1, maxPrice }
      });
  };
  if (profession === 'bard') tool(instruments, 'an instrument, a lute or drums', 'bard', 35);
  if (profession === 'fisherman' || profession === 'fisher') tool(fishingPoles, 'a fishing pole', 'fisherman', 20);
  if (profession === 'lumberjack') tool(hatchets, 'a hatchet', 'blacksmith', 30);
  if (profession === 'miner') tool(miningTools, 'a pickaxe or a shovel', 'tinker', 40);
  if (profession === 'tailor') tool(sewingKit, 'a sewing kit', 'tailor', 5);
  if (profession === 'bowyer') tool(new Set([0x1022, 0x1023]), 'fletching tools', 'bowyer', 4);
  if (profession === 'alchemist') tool(0x0e9b, 'a mortar and pestle', 'alchemist', 8);
  const supply = (
    graphic: number,
    amount: number,
    what: string,
    why: string,
    service: ServiceType,
    maxPrice: number
  ) => {
    const missing = amount - has(graphic);
    if (missing > 0)
      needs.push({ what, why, kind: 'supply', purchase: { service, graphics: [graphic], amount: missing, maxPrice } });
  };
  const fighter = [
    'swordsman',
    'fencer',
    'macer',
    'archer',
    'archer-tamer',
    'tank-mage',
    'pure-mage',
    'tamer'
  ].includes(profession);
  if (fighter) supply(bandage, 10, 'bandages', 'to bind my wounds between fights', 'healer', 5);
  if (fighter) supply(healPotion, 2, 'heal potions', 'for when a fight goes badly', 'alchemist', 30);
  if (profession.startsWith('archer')) {
    const ammo = rangedWeapon(equippedRanged(session)?.graphic)?.ammo ?? arrow;
    supply(ammo, 50, ammo === arrow ? 'arrows' : 'bolts', 'my quiver is nearly empty', 'bowyer', 3);
  }
  if (profession.endsWith('mage') && [...reagents].some((graphic) => (counts.get(graphic) ?? 0) < 10))
    needs.push({
      what: 'reagents',
      why: 'to cast my spells',
      kind: 'supply',
      purchase: {
        service: 'mage',
        graphics: [...reagents],
        amount: 10,
        maxPrice: 6,
        wanted: Object.fromEntries(
          [...reagents].map((graphic) => [graphic, Math.max(0, 10 - (counts.get(graphic) ?? 0))])
        )
      }
    });
  const funds = (session.world.status?.gold ?? 0) + knownBankGold(checkpoint);
  if (funds < LOW_FUNDS)
    needs.push({ what: 'a few coins', why: `I have only ${funds} gold to my name`, kind: 'income' });
  return needs;
}

// The needs as one spoken line, or the honest "nothing" with a question back.
export function needsLine(needs: readonly Need[]): string {
  const [first, second] = needs;
  if (!first) return 'I am well supplied, thank thee. And thou, dost thou lack anything?';
  if (!second) return `I could use ${first.what}; ${first.why}.`;
  return `I could use ${first.what}, ${first.why}, and ${second.what}.`;
}
