import { readFileSync } from 'node:fs';

import { spellbook } from '@gemwright/common/game/items';
import { classesShowing, craftSystemOf, sells } from '@gemwright/common/game/rules';
import { skillId } from '@gemwright/common/game/skills';
import { buyItem, dropInto, gumpReply, liftItem, sellItems, useItem, useSkill } from '@gemwright/network/packets';
import { Actions } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { spellNamed } from '../../src/spell-rules';
import {
  characterStatus,
  containerContents,
  gump,
  itemInContainer,
  loginConfirm,
  mobileIncoming,
  propertyList,
  removeEntity,
  sellList,
  skillUpdate,
  stockPrices,
  targetCursor
} from './shard-packets';

type Recipe = {
  name: string;
  group: number;
  label: number;
  min: number;
  amount: number;
  pays: number;
  graphic?: number;
  spell?: number;
  material?: number;
  extra?: { graphic: number; amount: number }[];
};
type Item = { serial: number; graphic: number; amount: number; parent: number };
const skillFile: Record<string, string> = { Tinkering: 'tinkering', Carpentry: 'carpentry', Inscribe: 'inscription' };

export function trainingShard(skill: string) {
  const world = new WorldView();
  const catalog = skillFile[skill]
    ? (JSON.parse(readFileSync(new URL(`../../catalogs/crafts/${skillFile[skill]}.json`, import.meta.url), 'utf8')) as {
        graphic: number;
        recipes: Recipe[];
      })
    : undefined;
  const spells = (
    JSON.parse(readFileSync(new URL('../../catalogs/magery-spells.json', import.meta.url), 'utf8')) as {
      spells: { id: number; name: string }[];
    }
  ).spells.map((s) => spellNamed(s.name));
  const stock = [
    ...new Map(['Mage', 'Tinker', 'Carpenter'].flatMap(sells).map((s) => [s.graphic, s])).values(),
    ...spells
      .filter((s) => s.circle <= 3)
      .map((s) => ({ type: 'SpellScroll', graphic: s.scroll, price: 12 + (s.circle - 1) * 10 }))
  ];
  const items = new Map<number, Item>();
  const purchases: { graphic: number; amount: number }[] = [];
  const known = new Set<number>([116]);
  const crafts: number[] = [];
  const casts: number[] = [];
  const sales: number[] = [];
  let next = 1000;
  let mana = 100;
  let learned = skill === 'Magery' || skill === 'Necromancy' ? 30 : 20;
  let cursorSpell: number | undefined;
  let toolsBroken = 0;
  const unit = (graphic: number) => (graphic === 3821 ? 0.02 : 0.1);
  const emit = (item: Item) => {
    world.apply(itemInContainer(item.serial, item.graphic, item.amount, item.parent));
    world.apply(propertyList(item.serial, 1072789, String(unit(item.graphic) * item.amount)));
  };
  const add = (graphic: number, amount: number, parent = 2) => {
    const old = [...items.values()].find((i) => i.graphic === graphic && i.parent === parent);
    const item = old ?? { serial: next++, graphic, amount: 0, parent };
    item.amount += amount;
    items.set(item.serial, item);
    emit(item);
    return item;
  };
  const consume = (graphic: number, amount: number) => {
    const stock = [...items.values()]
      .filter((i) => i.graphic === graphic && (i.parent === 2 || (graphic === 3821 && i.parent === 5)))
      .sort((a, b) => a.parent - b.parent);
    if (stock.reduce((n, i) => n + i.amount, 0) < amount) throw new Error(`Shard lacks ${graphic}: ${amount}`);
    for (const item of stock) {
      const take = Math.min(item.amount, amount);
      item.amount -= take;
      amount -= take;
      if (item.amount) emit(item);
      else {
        items.delete(item.serial);
        world.apply(removeEntity(item.serial));
      }
      if (!amount) break;
    }
  };
  const status = () =>
    world.apply(
      characterStatus(1, {
        hits: 100,
        maxHits: 100,
        mana,
        maxMana: 100,
        weight: Math.ceil(
          [...items.values()].filter((i) => i.parent === 2).reduce((n, i) => n + unit(i.graphic) * i.amount, 0)
        ),
        maxWeight: 400
      })
    );
  const say = (cliloc: number) => world.addJournal({ serial: 0xffffffff, name: 'System', cliloc });
  const groups = [...new Set(catalog?.recipes.map((r) => r.group))];
  const menu = (group?: number, notice?: number) => {
    const rows = groups
      .map(
        (id, i) => `{ button 30 ${50 + i * 20} 1 1 1 0 ${100 + i} }{ xmfhtmlgump 65 ${53 + i * 20} 140 20 ${id} 0 0 }`
      )
      .join('');
    const recipes = (catalog?.recipes ?? [])
      .flatMap((r, i) =>
        r.group === group
          ? [
              `{ button 180 ${50 + i * 20} 1 1 1 0 ${1000 + i} }{ xmfhtmlgump 215 ${53 + i * 20} 140 20 ${r.label} 0 0 }`
            ]
          : []
      )
      .join('');
    world.apply(gump(0, 42, rows + recipes + (notice ? `{ xmfhtmlgump 170 295 200 20 ${notice} 0 0 }` : '')));
  };
  world.apply(loginConfirm(1, 10, 10, 0, 2));
  world.map = 1;
  world.apply(
    mobileIncoming(1, 400, 10, 10, 0, 2, [
      { serial: 2, graphic: 3701, layer: 21 },
      { serial: 5, graphic: 2475, layer: 29 }
    ])
  );
  world.apply(mobileIncoming(20, 400, 12, 10, 0, 0));
  add(3821, 2000);
  for (const [name, value] of [
    ['Mining', 60],
    [skill, learned],
    ['Magery', 30]
  ] as const)
    world.apply(skillUpdate(skillId(name), value * 10));
  status();
  const finishCast = (id: number) => {
    const spell = spells.find((s) => s.id === id);
    if (id === 116) {
      consume(3982, 1);
      consume(3978, 1);
      mana -= 17;
      world.put({ serial: 1, kind: 'mobile', graphic: world.entities.get(1)?.graphic === 400 ? 748 : 400 });
    } else if (spell) {
      for (const graphic of spell.reagents) consume(graphic, 1);
      mana -= spell.mana;
    }
    casts.push(id);
    learned += 0.1;
    world.apply(skillUpdate(skillId(skill), Math.round(learned * 10)));
    status();
  };
  const session = {
    world,
    phase: 'ready',
    tap: undefined as PlayerSession['tap'],
    refreshSkills: async () => {},
    refreshStatus: async () => {
      mana = Math.min(100, mana + 10);
      status();
    },
    resyncPosition: async () => true,
    setWarMode: (on: boolean) => {
      world.warMode = on;
    },
    async walk(direction: number) {
      if (world.position) world.position = { ...world.position, x: 10, y: 10, direction };
      return true;
    },
    inspectProperties: async (serial: number) => {
      const i = items.get(serial);
      if (i) emit(i);
    },
    context: async () => [
      { cliloc: Actions.buy, index: 1, flags: 0 },
      { cliloc: Actions.sell, index: 2, flags: 0 }
    ],
    selectContext: (_vendor: number, index: number) => {
      if (index === 2) {
        world.apply(
          sellList(
            20,
            [...items.values()]
              .filter((i) => i.parent === 2 && i.graphic !== 3821)
              .map((i) => ({ ...i, price: 2, name: 'goods' }))
          )
        );
        return;
      }
      for (const [n, offer] of stock.entries()) {
        const container = 200 + n;
        world.apply(itemInContainer(container, 3701, 1, 20));
        world.apply(containerContents([{ serial: 500 + n, graphic: offer.graphic, amount: 100 }], container));
        world.apply(stockPrices(container, offer.price));
      }
    },
    async purchaseItem(vendor: number, serial: number, _pack: number, amount: number, budget: number) {
      const offer = [...world.buyOffers.values()].flat().find((o) => o.serial === serial);
      const graphic = world.entities.get(serial)?.graphic;
      if (!offer || graphic === undefined || offer.price * amount > budget) throw new Error('Invalid purchase');
      session.tap?.('out', buyItem(vendor, serial, amount));
      consume(3821, offer.price * amount);
      add(graphic, amount);
      status();
      purchases.push({ graphic, amount });
    },
    use: (serial: number) => {
      session.tap?.('out', useItem(serial));
      if (serial === 2 || serial === 5) {
        world.apply(
          containerContents(
            [...items.values()].filter((i) => i.parent === serial),
            serial
          )
        );
      } else if (items.has(serial)) menu();
    },
    replyGump: (serial: number, id: number, button: number) => {
      session.tap?.('out', gumpReply(serial, id, button, [], []));
      world.gumps.clear();
      if (button >= 100 && button < 1000) {
        menu(groups[button - 100]);
        return;
      }
      const recipe = catalog?.recipes[button - 1000];
      if (!recipe || !catalog || recipe.min > learned) throw new Error('Invalid recipe');
      if (recipe.spell && !known.has(recipe.spell)) {
        menu(recipe.group, 1042404);
        return;
      }
      consume(recipe.material ?? catalog.graphic, recipe.amount);
      for (const need of recipe.extra ?? []) consume(need.graphic, need.amount);
      const graphic =
        recipe.graphic ?? (recipe.label >= 1020000 && recipe.label < 1030000 ? recipe.label - 1020000 : 4175);
      add(graphic, 1);
      crafts.push(recipe.label);
      learned += 0.1;
      world.apply(skillUpdate(skillId(skill), Math.round(learned * 10)));
      const tool = [...items.values()].find(
        (i) =>
          i.parent === 2 &&
          classesShowing(i.graphic).some(
            (t) =>
              craftSystemOf(t) ===
              (skill === 'Tinkering' ? 'DefTinkering' : skill === 'Carpentry' ? 'DefCarpentry' : 'DefInscription')
          )
      );
      if (tool) {
        items.delete(tool.serial);
        world.apply(removeEntity(tool.serial));
        toolsBroken++;
      }
      menu(recipe.group, 1044154);
      status();
    },
    useSkill: (id: number, spell = false) => {
      session.tap?.('out', useSkill(id, spell));
      if (!spell) {
        say(500353);
        return;
      }
      if (!known.has(id)) {
        say(500015);
        return;
      }
      const rule = spells.find((s) => s.id === id);
      if (
        id !== 116 &&
        rule?.reagents.some((g) => ![...items.values()].some((i) => i.parent === 2 && i.graphic === g))
      ) {
        say(502630);
        return;
      }
      if (id === 116 || rule?.name === 'Magic Reflection') finishCast(id);
      else {
        cursorSpell = id;
        world.apply(targetCursor(1));
      }
    },
    target: (target: unknown) => {
      world.target = null;
      if (target && cursorSpell !== undefined) finishCast(cursorSpell);
      cursorSpell = undefined;
    },
    moveItem: async (serial: number, parent: number, amount?: number) => {
      const item = items.get(serial);
      if (!item) throw new Error('Missing transfer');
      session.tap?.('out', liftItem(serial, amount ?? item.amount));
      session.tap?.('out', dropInto(serial, parent));
      if (world.entities.get(parent)?.graphic === spellbook) {
        const spell = spells.find((s) => s.scroll === item.graphic);
        if (!spell) throw new Error('Not a spell scroll');
        known.add(spell.id);
        consume(item.graphic, 1);
      } else {
        item.parent = parent;
        emit(item);
      }
      status();
    },
    say: (_text: string) => {},
    async sell(vendor: number, offers: { serial: number; amount: number }[]) {
      session.tap?.('out', sellItems(vendor, offers));
      for (const offer of offers) {
        const item = items.get(offer.serial);
        if (item?.parent !== 2) throw new Error('Invalid sale');
        sales.push(item.graphic);
        consume(item.graphic, offer.amount);
        add(3821, 2 * offer.amount);
      }
      status();
    }
  } as unknown as PlayerSession;
  return {
    world,
    session,
    items,
    purchases,
    casts,
    crafts,
    known,
    sales,
    add,
    status,
    state: () => ({ learned, toolsBroken })
  };
}
