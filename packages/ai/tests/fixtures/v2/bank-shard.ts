import { Layer } from '@gemwright/network/layers';
import { dropInto, liftItem, sellItems, variable } from '@gemwright/network/packets';
import { Actions } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import {
  characterStatus,
  itemInContainer,
  loginConfirm,
  mobileIncoming,
  removeEntity,
  sellList
} from './shard-packets';

type Item = { serial: number; graphic: number; amount: number; parent: number };
export function bankShard() {
  const world = new WorldView();
  const items = new Map<number, Item>([
    [10, { serial: 10, graphic: 7154, amount: 3000, parent: 5 }],
    [11, { serial: 11, graphic: 3718, amount: 1, parent: 2 }]
  ]);
  const moves: { serial: number; amount: number; parent: number; weight: number }[] = [];
  let serial = 100;
  let sold = 0;
  let sales = 0;
  let deposits = 0;
  let bankVisits = 0;
  const unit = (item: Item) => (item.graphic === 3821 ? 0.02 : item.graphic === 7154 ? 0.2 : 5);
  const emit = (item: Item) => {
    world.apply(itemInContainer(item.serial, item.graphic, item.amount, item.parent));
    const entity = world.entities.get(item.serial);
    if (entity)
      world.put({ ...entity, properties: [{ cliloc: 1072789, arguments: String(item.amount * unit(item)) }] });
  };
  const status = () =>
    world.apply(
      characterStatus(1, {
        hits: 100,
        maxHits: 100,
        weight: Math.ceil(
          100 + [...items.values()].filter((i) => i.parent === 2).reduce((sum, i) => sum + i.amount * unit(i), 0)
        ),
        maxWeight: 150
      })
    );
  const protection = Buffer.alloc(47);
  protection.writeUInt32BE(0xffffffff, 0);
  protection.writeUInt32BE(500112, 11);
  world.apply(loginConfirm(1, 10, 10, 0, 2));
  world.apply(variable(0xbf, Buffer.from([0, 8, 1])));
  world.apply(
    mobileIncoming(1, 400, 10, 10, 0, 2, [
      { serial: 2, graphic: 3701, layer: Layer.Backpack },
      { serial: 5, graphic: 3701, layer: Layer.Bank }
    ])
  );
  world.apply(mobileIncoming(20, 400, 12, 10, 0, 6));
  world.apply(variable(0xc1, protection));
  for (const item of items.values()) emit(item);
  status();
  const session = {
    world,
    phase: 'ready',
    tap: undefined as PlayerSession['tap'],
    refreshSkills: async () => {},
    refreshStatus: async () => status(),
    inspectProperties: async (id: number) => {
      const item = items.get(id);
      if (item) emit(item);
    },
    requestName: () => {},
    say: (text: string) => {
      if (text === 'bank') bankVisits++;
    },
    setWarMode: (enabled: boolean) => {
      world.warMode = enabled;
    },
    use: () => {},
    async moveItem(id: number, parent: number, requested?: number) {
      const item = items.get(id);
      if (!item) throw new Error('Missing item');
      const amount = Math.min(requested ?? item.amount, item.amount);
      session.tap?.('out', liftItem(id, amount));
      if (amount < item.amount) {
        const remainder = { ...item, serial: serial++, amount: item.amount - amount };
        items.set(remainder.serial, remainder);
        emit(remainder);
      }
      session.tap?.('out', dropInto(id, parent));
      item.amount = amount;
      item.parent = parent;
      emit(item);
      status();
      moves.push({ serial: id, amount, parent, weight: world.status?.weight ?? 0 });
      if (parent === 5) deposits++;
    },
    context: async () => [{ cliloc: Actions.sell, index: 2, flags: 0 }],
    selectContext: () => {
      const offers = [...items.values()]
        .filter((i) => i.parent === 2 && i.graphic === 7154)
        .map((i) => ({ ...i, price: 4, name: 'iron ingot' }));
      if (offers.length) world.apply(sellList(20, offers));
    },
    async sell(vendor: number, offers: { serial: number; amount: number }[]) {
      session.tap?.('out', sellItems(vendor, offers));
      for (const offer of offers) {
        const item = items.get(offer.serial);
        if (item?.parent !== 2) throw new Error('Sold goods outside backpack');
        sold += offer.amount;
        item.amount -= offer.amount;
        if (item.amount) emit(item);
        else {
          items.delete(item.serial);
          world.apply(removeEntity(item.serial));
        }
        const gold = [...items.values()].find((i) => i.parent === 2 && i.graphic === 3821);
        if (gold) {
          gold.amount += offer.amount * 4;
          emit(gold);
        } else {
          const created = { serial: serial++, graphic: 3821, amount: offer.amount * 4, parent: 2 };
          items.set(created.serial, created);
          emit(created);
        }
      }
      status();
      sales++;
    }
  } as unknown as PlayerSession;
  return { world, session, moves, items, state: () => ({ sold, sales, deposits, bankVisits }) };
}
