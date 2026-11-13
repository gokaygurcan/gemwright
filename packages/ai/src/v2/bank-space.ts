import { classesShowing, isA } from '@gemwright/common/game/rules';
import { Opcode } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { facts } from './knowledge';
import { screenOf } from './perceive';

export function descendants(items: Iterable<Entity>, root: number) {
  const all = [...items];
  const inside = new Set([root]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of all)
      if (item.parent !== undefined && inside.has(item.parent) && !inside.has(item.serial)) {
        inside.add(item.serial);
        changed = true;
      }
  }
  inside.delete(root);
  return all.filter((i) => inside.has(i.serial));
}

export function bankCount(items: Iterable<Entity>, box: Entity) {
  const known = descendants(items, box.serial).length;
  const contents = facts(box.properties ?? []).contents;
  return { count: Math.max(known, contents?.count ?? 0), max: contents?.max ?? 125 };
}

export async function seeBank(session: PlayerSession, going: () => boolean | Promise<boolean>) {
  const world = screenOf(session);
  const root = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === 29);
  if (root && session.inspectProperties) await session.inspectProperties(root.serial, true);
  const opened = new Set<number>();
  for (;;) {
    const bank = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === 29);
    if (!bank || !(await going())) return false;
    const bag = descendants(world.entities.values(), bank.serial).find(
      (i) => !opened.has(i.serial) && classesShowing(i.graphic).some((t) => isA(t, 'BaseContainer'))
    );
    if (!bag) return true;
    opened.add(bag.serial);
    const before = world.received.get(Opcode.containerContents) ?? 0;
    session.use(bag.serial);
    let answered = false;
    for (const end = Date.now() + 3000; Date.now() < end; ) {
      if (!(await going())) return false;
      if ((world.received.get(Opcode.containerContents) ?? 0) > before) {
        answered = true;
        break;
      }
      await Bun.sleep(100);
    }
    if (!answered) return false;
  }
}
