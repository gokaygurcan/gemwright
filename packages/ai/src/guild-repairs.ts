import { skillId } from '@gemwright/common/skills';

import { canPause } from './action-purpose';
import { guildOfMember } from './guild-store';
import { awaitGump, buttonFor, dismiss, press } from './gump-flow';
import { packItems } from './inventory';
import type { LifeContext } from './life';
import { serviceLocations } from './locations';
import { distance } from './navigation';
import { completeObjective, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { rememberPartner } from './resident-memory';
import { sellByTrade } from './trade-deal';

export function durability(item: Entity): { current: number; maximum: number } | undefined {
  const values = item.properties
    ?.find((p) => p.cliloc === 1060639)
    ?.arguments.split('\t')
    .map(Number);
  if (values?.length !== 2 || !values.every(Number.isFinite) || !values[1] || (values[0] ?? -1) < 0) return undefined;
  return { current: values[0] ?? 0, maximum: values[1] };
}
export function smithContract(item: Entity): boolean {
  return (
    item.graphic === 0x14f0 &&
    !!item.properties?.some((p) => p.cliloc === 1061133 && /#1023015\b|blacksmith/i.test(p.arguments))
  );
}
export function damagedMetal(ctx: Pick<LifeContext, 'session' | 'terrain'>): Entity | undefined {
  return ctx.session.world.childrenOf(ctx.session.world.serial ?? -1).find((item) => {
    const d = durability(item);
    return (
      d &&
      d.maximum > 10 &&
      d.current / d.maximum < 0.55 &&
      /plate|chain|ringmail|metal|sword|kryss|spear|mace|hammer|war fork|dagger|halberd|axe|maul|helmet|buckler|shield/i.test(
        ctx.terrain.tile(item.graphic, true).name
      )
    );
  });
}
export function usefulRepairContract(session: PlayerSession, item: Entity): boolean {
  return (
    smithContract(item) &&
    session.world.childrenOf(session.world.serial ?? -1).some((e) => {
      const d = durability(e);
      return d && d.maximum > 10 && d.current / d.maximum < 0.55;
    })
  );
}

export async function guildRepairTurn(ctx: LifeContext): Promise<boolean> {
  const { session, checkpoint } = ctx;
  if (!canPause(session) || session.world.target || (session.world.trade && !session.world.trade.closed)) return false;
  const pack = session.world.childrenOf(session.world.serial ?? -1).find((e) => e.layer === Layer.Backpack);
  if (!pack) return false;
  const key = 'guild-repair',
    condition = suppliesCondition(session, checkpoint);
  if (objectiveBlocked(checkpoint, key, condition)) return false;
  await inspectRepairGear(ctx);
  if (!canPause(session) || session.world.target) return false;
  const items = packItems(session, pack.serial);
  const damaged = damagedMetal(ctx),
    contract = items.find(smithContract);
  let ownsCursor = false;
  try {
    if (damaged && contract) {
      const shop = [...serviceLocations(ctx.city, 'blacksmith')].sort(
        (a, b) => distance(ctx.position(), a) - distance(ctx.position(), b)
      )[0];
      if (!shop || distance(ctx.position(), shop) > 150) return false;
      const before = durability(damaged);
      if (!before) return false;
      await ctx.navigate(shop, 3);
      ctx.check();
      if (!canPause(session)) return false;
      ctx.phase('repairing-equipment', 'Using a smith repair contract near the workshop');
      if (session.world.target) return false;
      ownsCursor = true;
      session.use(contract.serial);
      await session.waitFor(() => session.world.target !== null, 'repair contract cursor', 3000);
      ctx.check();
      session.target({ serial: damaged.serial, x: 0, y: 0, z: 0, graphic: damaged.graphic });
      await session
        .waitFor(() => !session.world.entities.has(contract.serial), 'repair contract consumed', 3000)
        .catch(() => {});
      await session.inspectProperties(damaged.serial, true);
      const after = durability(session.world.entities.get(damaged.serial) ?? damaged);
      if (after && after.current > before.current) {
        completeObjective(checkpoint, key);
        ctx.persist();
        return true;
      }
      failObjective(
        checkpoint,
        key,
        suppliesCondition(session, checkpoint),
        'Repair did not restore observed durability'
      );
      ctx.persist();
      return true;
    }
    const self = session.world.entities.get(session.world.serial ?? -1);
    const guild = self?.name && guildOfMember(self.name);
    if (!guild || (session.world.skills.get(skillId('Blacksmith'))?.value ?? 0) < 80) return false;
    const mate = [...session.world.entities.values()].find(
      (e) =>
        e.serial !== self?.serial &&
        e.kind === 'mobile' &&
        e.name &&
        guildOfMember(e.name) === guild &&
        e.position &&
        distance(ctx.position(), e.position) <= 2 &&
        session.world.childrenOf(e.serial).some((e) => {
          const d = durability(e);
          return d && d.maximum > 10 && d.current / d.maximum < 0.55;
        })
    );
    if (!mate) return false;
    let deed = contract;
    if (!deed) {
      const tool = items.find((e) => [0xfbb, 0xfbc, 0x13e3, 0x13e4].includes(e.graphic));
      const scroll = items.find((e) => e.graphic === 0xe34);
      if (!tool || !scroll) return false;
      const before = new Set(items.map((e) => e.serial));
      if (session.world.target || !canPause(session)) return false;
      ownsCursor = true;
      dismiss(session, 1044010);
      session.use(tool.serial);
      const gump = await awaitGump(session, 1044010, 'smith craft menu', 3000);
      const button = buttonFor(gump.layout, 1044260);
      if (button === undefined) return false;
      press(session, gump, button);
      await session.waitFor(() => session.world.target !== null, 'repair creation cursor', 3000);
      ctx.check();
      session.target({ serial: scroll.serial, x: 0, y: 0, z: 0, graphic: scroll.graphic });
      await session.waitFor(
        () => packItems(session, pack.serial).some((e) => !before.has(e.serial) && e.graphic === 0x14f0),
        'created repair contract',
        3000
      );
      deed = packItems(session, pack.serial).find((e) => !before.has(e.serial) && e.graphic === 0x14f0);
      if (deed) await session.inspectProperties(deed.serial);
      if (!deed || !smithContract(session.world.entities.get(deed.serial) ?? deed)) return false;
    }
    ctx.phase('guild-repair', 'Offering my guildmate a smith repair contract');
    session.say(`${mate.name?.split(' ')[0]}, this repair contract can help with your worn equipment.`);
    if (await sellByTrade(session, pack.serial, mate.serial, (item) => item.serial === deed?.serial, 1, 0)) {
      rememberPartner(checkpoint, {
        partner: mate.serial,
        name: mate.name ?? 'guildmate',
        kind: 'repair',
        result: 'completed',
        detail: 'Supplied a smith repair contract for worn equipment',
        id: `repair-contract:${deed.serial}`
      });
      completeObjective(checkpoint, key);
    } else
      failObjective(
        checkpoint,
        key,
        suppliesCondition(session, checkpoint),
        'Repair contract handover did not complete'
      );
    ctx.persist();
    return true;
  } catch (error) {
    ctx.check();
    failObjective(
      checkpoint,
      key,
      suppliesCondition(session, checkpoint),
      error instanceof Error ? error.message : 'Repair unavailable'
    );
    ctx.persist();
    return false;
  } finally {
    if (ownsCursor && session.phase === 'ready' && session.world.target) session.target(null);
  }
}

const inspected = new WeakMap<PlayerSession, Map<number, number>>();
async function inspectRepairGear(ctx: LifeContext) {
  const { session } = ctx;
  const seen = inspected.get(session) ?? new Map<number, number>();
  inspected.set(session, seen);
  for (const id of seen.keys()) if (!session.world.entities.has(id)) seen.delete(id);
  const self = session.world.entities.get(session.world.serial ?? -1);
  const guild = self?.name && guildOfMember(self.name);
  const actors = [
    session.world.serial ?? -1,
    ...(guild
      ? [...session.world.entities.values()]
          .filter(
            (e) =>
              e.serial !== session.world.serial &&
              e.name &&
              guildOfMember(e.name) === guild &&
              e.position &&
              distance(ctx.position(), e.position) <= 4
          )
          .map((e) => e.serial)
      : [])
  ];
  const gear = actors
    .flatMap((id) => session.world.childrenOf(id))
    .filter(
      (e) =>
        e.layer &&
        ![Layer.Backpack, Layer.Bank, Layer.Mount, Layer.Hair, Layer.FacialHair].some((layer) => layer === e.layer)
    );
  for (const item of gear.filter((e) => Date.now() - (seen.get(e.serial) ?? 0) > 60_000).slice(0, 2)) {
    ctx.check();
    if (!canPause(session)) return;
    seen.set(item.serial, Date.now());
    await session.inspectProperties(item.serial, !!item.properties).catch(() => {});
  }
}
