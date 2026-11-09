import {
  banks,
  buys,
  graphicsListed,
  harvestOf,
  heals,
  listsOf,
  npcTypes,
  sells,
  vendorListNames
} from '@gemwright/common/game/rules';

import type { ServiceType } from './locations';

// Which NPC types give a service, by the ServUO rules (@gemwright/common/game/rules): a trade is
// the NPC types that carry that trade's vendor list (SBTinker for 'tinker', SBJewel for 'jeweler'),
// 'mining-tools' the ones that sell a mining tool, 'banker' and 'healer' the Banker and BaseHealer
// kinds. Graveyards are no NPC (cemeteries.ts).
const trades: ServiceType[] = [
  'alchemist',
  'animal-trainer',
  'architect',
  'bard',
  'blacksmith',
  'bowyer',
  'carpenter',
  'cobbler',
  'cook',
  'fisherman',
  'jeweler',
  'mage',
  'provisioner',
  'tailor',
  'tinker',
  'weaponsmith'
];
const plain = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '');
// The vendor list named for a trade: SB + the trade (SBWeaponSmith), or its stem (SBJewel).
const listOf = (trade: ServiceType) =>
  vendorListNames.find((list) => {
    const name = plain(list.slice(2));
    const wanted = plain(trade);
    return name === wanted || (wanted.startsWith(name) && name.length >= 4);
  });
const tradeLists = new Map(trades.flatMap((trade) => (listOf(trade) ? [[listOf(trade) as string, trade]] : [])));

const byType = new Map<string, ServiceType[]>();
for (const npc of npcTypes) {
  const services = new Set<ServiceType>();
  if (banks(npc)) services.add('banker');
  if (heals(npc)) services.add('healer');
  for (const list of listsOf(npc)) {
    const trade = tradeLists.get(list);
    if (trade) services.add(trade);
  }
  if (sells(npc).some(({ type }) => harvestOf(type) === 'mining')) services.add('mining-tools');
  if (services.size) byType.set(npc.toLowerCase(), [...services]);
}

// The services an NPC type gives, by its type name as spawners name it (any case).
export const servicesOf = (type: string): readonly ServiceType[] => byType.get(type.toLowerCase()) ?? [];

// Which trades buy an item, by its graphic, from the ServUO vendor lists' buy side (GenericSellInfo):
// every vendor of a trade buys the same things, so a trade that does not list it never will.
const buyerTrades = new Map<number, Set<ServiceType>>();
for (const npc of npcTypes) {
  const own = listsOf(npc).flatMap((list) => tradeLists.get(list) ?? []);
  if (!own.length) continue;
  for (const { type } of buys(npc))
    for (const graphic of graphicsListed(type)) {
      const set = buyerTrades.get(graphic) ?? new Set<ServiceType>();
      for (const trade of own) set.add(trade);
      buyerTrades.set(graphic, set);
    }
}
export const tradesBuying = (graphic: number): ServiceType[] => [...(buyerTrades.get(graphic) ?? [])];
