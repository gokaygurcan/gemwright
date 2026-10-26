import { PLAIN_HUMAN_BODIES } from '@gemwright/common/bodies';
import { gold } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { checkedDelay } from './action-purpose';
import { isResident } from './activity';
import { escortForPay } from './escort';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';

type SubsistenceContext = Pick<
  ProfessionContext,
  'session' | 'serial' | 'count' | 'check' | 'position' | 'phase' | 'navigate' | 'log'
>;

// Begs human NPCs until `want` gold is carried or ten tries are spent; true when it has enough.
// ServUO pays a tenth of the target's own gold (up to 10 coins), so townsfolk (innocent, blue)
// come first; shopkeepers (invulnerable) carry none in their packs. Residents are never asked, and
// a real player only answers "Perhaps just asking would work better".
export async function begForTool(ctx: SubsistenceContext, want: number) {
  const { session } = ctx;
  const carriedGold = () => ctx.count(gold);
  // An escort pays 500 to 1,000 gold; begging, a few coins (escort.ts).
  if (carriedGold() < want && (await escortForPay(ctx).catch(() => false))) return carriedGold() >= want;
  const asked = new Set<number>();
  for (let tries = 0; tries < 10 && carriedGold() < want; tries++) {
    ctx.check();
    const here = ctx.position();
    const npc = [...session.world.entities.values()]
      .filter(
        (m) =>
          m.kind === 'mobile' &&
          PLAIN_HUMAN_BODIES.has(m.graphic) &&
          (m.notoriety === 1 || m.notoriety === 7) &&
          m.serial !== ctx.serial &&
          !isResident(m.serial) &&
          m.position &&
          !asked.has(m.serial)
      )
      .sort(
        (a, b) =>
          (a.notoriety === 1 ? 0 : 1000) +
          distance(here, a.position ?? here) -
          ((b.notoriety === 1 ? 0 : 1000) + distance(here, b.position ?? here))
      )[0];
    if (!npc?.position) break;
    asked.add(npc.serial);
    ctx.phase('begging', 'Begging for a few coins');
    await ctx.navigate(npc.position, 1).catch(() => {});
    session.useSkill(skillId('Begging'));
    await session.waitFor(() => session.world.target !== null, 'begging cursor', 3000).catch(() => {});
    ctx.check();
    if (!session.world.target) continue;
    session.target({ serial: npc.serial, x: 0, y: 0, z: 0, graphic: npc.graphic });
    await checkedDelay(4000, ctx.check);
  }
  return carriedGold() >= want;
}
