import { readFileSync } from 'node:fs';

import { GHOST_BODIES } from '@gemwright/common/bodies';

import { resurrectionButton } from './fighter-recovery';
import { allServiceLocations } from './locations';
import { moongates, nearestGate, travelByMoongate } from './moongate';
import type { MountContext } from './mount-types';
import { distance } from './navigation';

const ghosts = GHOST_BODIES;
const WALKING_LIMIT = 300;
const ankhs = (
  JSON.parse(readFileSync(new URL('../locations/ankhs.json', import.meta.url), 'utf8')) as {
    ankhs: { x: number; y: number; z: number }[];
  }
).ankhs;

type Ctx = Pick<MountContext, 'session' | 'serial' | 'terrain' | 'position' | 'navigate' | 'check' | 'phase' | 'log'>;

export const isGhost = (ctx: Pick<Ctx, 'session' | 'serial'>) =>
  ghosts.has(ctx.session.world.entities.get(ctx.serial)?.graphic ?? 0);

// Travel effort to a point: walking distance, or the walk to the nearest gate plus the walk from
// the gate nearest the destination when the trip is too far to walk.
function effort(from: { x: number; y: number }, to: { x: number; y: number }) {
  const direct = distance(from, to);
  if (direct <= WALKING_LIMIT) return direct;
  return distance(from, moongates[nearestGate(from)]) + distance(moongates[nearestGate(to)], to) + 20;
}

// Resurrects a ghost at the closest healer or ankh, as a player would. Healers (BaseHealer) and
// ankhs (Ankhs.OnMovement) both send ResurrectGump when a ghost steps into range; the free
// Continue reply is accepted. Tries the next closest option when one does not offer.
export async function resurrectGhost(ctx: Ctx) {
  const { session, check, phase, log, navigate, position } = ctx;
  const offer = () => [...session.world.gumps.values()].find((gump) => resurrectionButton(gump.layout) !== undefined);
  const options = [
    ...allServiceLocations('healer').map((point) => ({ kind: 'healer' as const, ...point })),
    ...ankhs.map((point) => ({ kind: 'ankh' as const, name: 'ankh', ...point }))
  ].sort((a, b) => effort(position(), a) - effort(position(), b));
  for (const option of options.slice(0, 4)) {
    if (!isGhost(ctx)) break;
    check();
    phase('seeking-resurrection', `Travelling as a ghost to the ${option.kind} near ${option.x},${option.y}`);
    try {
      if (distance(position(), option) > WALKING_LIMIT) {
        const gate = nearestGate(option);
        if (distance(position(), moongates[gate]) > 2) await travelByMoongate(ctx, gate);
      }
      if (option.kind === 'ankh') {
        // The offer comes when stepping into range 1 from outside it.
        await navigate(option, 3);
        await navigate(option, 1);
      } else {
        // From inside a building (a ghost cannot open doors) the spot may be out of reach while the
        // healer is already in view.
        await navigate(option, 4).catch((error) => {
          if (session.phase !== 'ready') throw error;
        });
        // Townsfolk crowd the healer's spot: the healer is the NPC whose name property (1050045)
        // ends "the healer" or "the wandering healer"; guildmasters are not healers. Failing that,
        // the NPC nearest the known spot.
        const npcs = [...session.world.entities.values()]
          .filter(
            (m) => m.kind === 'mobile' && m.notoriety === 7 && m.position && distance(position(), m.position) <= 10
          )
          .sort((a, b) => distance(option, a.position ?? option) - distance(option, b.position ?? option));
        let healer: (typeof npcs)[number] | undefined;
        for (const npc of npcs.slice(0, 6)) {
          await session.inspectProperties(npc.serial).catch(() => {});
          const title = session.world.entities.get(npc.serial)?.properties?.find((p) => p.cliloc === 1050045);
          if (/the (wandering )?healer\s*$/i.test(title?.arguments ?? '')) {
            healer = npc;
            break;
          }
        }
        healer ??= npcs[0];
        if (healer?.position) {
          // BaseHealer.OnMovement offers only on stepping into range 2 from outside it, so a
          // ghost already close steps out to any reachable tile three to five away first, then
          // closes in a tile at a time until the offer comes.
          const at = healer.position;
          if (distance(position(), at) <= 2)
            outward: for (const reach of [3, 4, 5])
              for (const [dx, dy] of [
                [1, 0],
                [0, 1],
                [-1, 0],
                [0, -1],
                [1, 1],
                [-1, 1],
                [1, -1],
                [-1, -1]
              ] as const) {
                const tile = ctx.terrain.stand(at.x + dx * reach, at.y + dy * reach, position().z);
                if (!tile) continue;
                try {
                  await navigate(tile, 0);
                  break outward;
                } catch (error) {
                  if (session.phase !== 'ready') throw error;
                }
              }
          for (const range of [3, 2, 1]) {
            if (offer() || !isGhost(ctx)) break;
            const now = session.world.entities.get(healer.serial)?.position ?? at;
            await navigate(now, range).catch((error) => {
              if (session.phase !== 'ready') throw error;
            });
            await Bun.sleep(800);
          }
        }
      }
      await session.waitFor(() => !!offer() || !isGhost(ctx), 'resurrection offer', 6000);
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      log(
        `No resurrection at the ${option.kind} near ${option.x},${option.y}: ${error instanceof Error ? error.message : error}`
      );
      continue;
    }
    const gump = offer();
    if (gump) {
      session.replyGump(gump.serial, gump.id, resurrectionButton(gump.layout) ?? 1, []);
      await session.waitFor(() => !isGhost(ctx), 'living character after resurrection', 5000).catch(() => {});
    }
  }
  if (isGhost(ctx)) throw new Error('No healer or ankh offered a resurrection yet');
  phase('resurrected', 'The server confirmed a living body');
}
