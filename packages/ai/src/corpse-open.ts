import { corpse as corpseGraphic } from '@gemwright/common/game/items';
import { Opcode } from '@gemwright/network/opcodes';
import { ShardMessage } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { distance } from './navigation';

// Opening what a death left, as one player action for every resident: the corpse is found (the
// death packet can name serial 0, so it is looked for where the creature fell), reached, opened,
// and either its contents come back or the shard's reason does — too far, or another player's kill
// (Corpse.CheckLoot). What to take is the caller's own choice.
export interface Death {
  corpse: number;
  position?: { x: number; y: number; z?: number };
}
type Ctx = {
  session: PlayerSession;
  position: () => { x: number; y: number; z: number };
  navigate: (point: { x: number; y: number }, range: number) => Promise<unknown>;
};

function corpseNear(session: PlayerSession, here: { x: number; y: number }, range: number, skip: Set<number>) {
  return [...session.world.entities.values()]
    .filter(
      (e) =>
        e.kind === 'item' &&
        e.graphic === corpseGraphic &&
        e.serial !== 0 &&
        !!e.position &&
        !skip.has(e.serial) &&
        distance(here, e.position) <= range
    )
    .sort((a, b) => distance(here, a.position ?? here) - distance(here, b.position ?? here))[0];
}

export async function openCorpse(
  ctx: Ctx,
  death: Death | undefined,
  skip = new Set<number>()
): Promise<{ corpse: number; items: Entity[] } | { why: 'not-found' | 'too-far' | 'denied' }> {
  const { session } = ctx;
  const declared = death?.corpse;
  const body =
    declared && session.world.entities.get(declared)?.graphic === corpseGraphic
      ? session.world.entities.get(declared)
      : // A kill that drifted is still found: without a death position the search reaches further.
        corpseNear(session, death?.position ?? ctx.position(), death?.position ? 4 : 8, skip);
  if (!body?.position) return { why: 'not-found' };
  const at = body.position;
  await ctx.navigate(at, 1);
  const before = session.world.received.get(Opcode.containerContents) ?? 0;
  const heard = new Set(session.world.journal);
  const said = (cliloc: number) => session.world.journal.some((e) => !heard.has(e) && e.cliloc === cliloc);
  const look = async () => {
    if (distance(ctx.position(), at) > 1) await ctx.navigate(at, 0).catch(() => {});
    session.use(body.serial);
    await session.waitFor(
      () =>
        (session.world.received.get(Opcode.containerContents) ?? 0) > before ||
        said(ShardMessage.corpseDenied) ||
        said(ShardMessage.tooFar),
      'container contents',
      4000
    );
  };
  try {
    await look();
  } catch (error) {
    if (session.phase !== 'ready') throw error;
    // One more look from the corpse's own tile before giving up on it.
    await ctx.navigate(at, 0).catch(() => {});
    await look();
  }
  if (said(ShardMessage.tooFar)) return { why: 'too-far' };
  if (said(ShardMessage.corpseDenied)) return { why: 'denied' };
  return { corpse: body.serial, items: session.world.childrenOf(body.serial) };
}
