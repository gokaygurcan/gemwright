import { readFileSync } from 'node:fs';

import { GHOST_BODIES } from '@gemwright/common/bodies';

import { Blocked } from './blocked';
import { recoverOwnCorpse } from './corpse-recovery';
import { threatsNear } from './danger';
import { resurrectionButton } from './fighter-recovery';
import { tidyPack } from './inventory';
import { allServiceLocations } from './locations';
import { mendAfterDeath } from './mend';
import { moongates, nearestGate, travelByMoongate } from './moongate';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import { dyingOverAndOver, noteDeath, useStuckMenu } from './stuck';

const ghosts = GHOST_BODIES;
const WALKING_LIMIT = 300;
// Ankh pieces a ghost can double-click (Ankhs.cs AnkhWest and AnkhNorth, plain or bloodied).
const ankhGraphics = new Set([
  0x0002, // ankh, west, second piece
  0x0003, // ankh, west
  0x0004, // ankh, north
  0x0005, // ankh, north, second piece
  0x1d97, // bloodied ankh, west, second piece
  0x1d98, // bloodied ankh, west
  0x1e5c, // bloodied ankh, north, second piece
  0x1e5d // bloodied ankh, north
]);
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

// Resurrects a ghost at the closest healer or ankh, as a player would. A ghost stays in the town
// it is in: moongates only when no healer or ankh is within walking range. Healers (BaseHealer) and
// ankhs (Ankhs.OnMovement) both send ResurrectGump when a ghost steps into range; the free
// Continue reply is accepted. Tries the next closest option when one does not offer.
// Then, unless the caller recovers corpses itself (fighters), it goes back for its belongings
// (corpse-recovery.ts).
const seenDeath = new WeakMap<PlayerSession, number>();
export async function resurrectGhost(ctx: Ctx, recoverCorpse = true) {
  const { session, check, phase, log, navigate, position } = ctx;
  // A ghost rises where it fell: its corpse lies here.
  const fell = { x: position().x, y: position().y };
  const diedAt = Date.now();
  // What killed it, for the logs (and the next decision about this road).
  if (!seenDeath.has(session) || Date.now() - (seenDeath.get(session) ?? 0) > 10 * 60_000) {
    seenDeath.set(session, Date.now());
    const near = threatsNear(session, fell, 14).map((m) => m.name ?? `0x${m.graphic.toString(16)}`);
    log(`[death] died at ${fell.x},${fell.y}${near.length ? ` near ${[...new Set(near)].join(', ')}` : ''}`);
  }
  const offer = () => [...session.world.gumps.values()].find((gump) => resurrectionButton(gump.layout) !== undefined);
  const all = [
    ...allServiceLocations('healer').map((point) => ({ kind: 'healer' as const, ...point })),
    ...ankhs.map((point) => ({ kind: 'ankh' as const, name: 'ankh', ...point }))
  ].sort((a, b) => effort(position(), a) - effort(position(), b));
  // Every healer and ankh in walking range first, each tried many times; another city only when
  // none of them can be reached at all (a shrine ankh with no route to it).
  const local = all.filter((option) => distance(position(), option) <= WALKING_LIMIT);
  const options = [...local, ...all.filter((option) => !local.includes(option))];
  // A healer met on the way (a wandering healer between towns, or any town healer in view) comes
  // before the trip to the next catalogued one.
  const met = new Set<number>();
  const healerInView = async () => {
    const npcs = [...session.world.entities.values()].filter(
      (m) =>
        m.kind === 'mobile' &&
        m.notoriety === 7 &&
        m.position &&
        !met.has(m.serial) &&
        distance(position(), m.position) <= 18
    );
    for (const npc of npcs.slice(0, 8)) {
      await session.inspectProperties(npc.serial).catch(() => {});
      const title = session.world.entities.get(npc.serial)?.properties?.find((p) => p.cliloc === 1050045);
      if (!/the (wandering )?healer\s*$/i.test(title?.arguments ?? '') || !npc.position) continue;
      met.add(npc.serial);
      return {
        kind: 'healer' as const,
        name: 'healer in view',
        city: '',
        facet: 1,
        x: npc.position.x,
        y: npc.position.y
      };
    }
    return undefined;
  };
  const queue = options.slice(0, Math.max(4, local.length + 2));
  while (queue.length) {
    const option = (isGhost(ctx) && (await healerInView())) || queue.shift();
    if (!option) break;
    if (!isGhost(ctx)) break;
    check();
    phase('seeking-resurrection', `Travelling as a ghost to the ${option.kind} near ${option.x},${option.y}`);
    try {
      if (distance(position(), option) > WALKING_LIMIT) {
        const gate = nearestGate(option);
        // Far from every moongate (out in the wilds) a ghost simply walks: monsters ignore ghosts.
        if (distance(position(), moongates[gate]) > 2)
          await travelByMoongate(ctx, gate).catch((error) => {
            if (!(error instanceof Blocked)) throw error;
          });
      }
      if (option.kind === 'ankh') {
        // The offer comes when stepping into range 1 from outside it, or when a ghost double-clicks
        // the ankh from within two tiles (Ankhs.OnDoubleClickDead): up to 25 tries.
        // The catalog point may be on the shrine itself, out of reach: the ankh in view decides.
        await navigate(option, 3).catch((error) => {
          if (session.phase !== 'ready') throw error;
        });
        for (let pass = 0; pass < 25 && !offer() && isGhost(ctx); pass++) {
          const ankh = [...session.world.entities.values()]
            .filter((item) => item.kind === 'item' && ankhGraphics.has(item.graphic) && item.position)
            .sort((a, b) => distance(position(), a.position ?? option) - distance(position(), b.position ?? option))[0];
          if (!ankh?.position) throw new Error('No ankh in view');
          if (ankh.position) {
            if (distance(position(), ankh.position) > 2) await navigate(ankh.position, 2).catch(() => {});
            session.use(ankh.serial);
          }
          await Bun.sleep(1500);
        }
        // What the server said: 500446 too far away, 502391 cannot be resurrected there.
        const refusal = session.world.journal.filter((e) => e.cliloc === 500446 || e.cliloc === 502391).at(-1);
        if (!offer() && refusal)
          log(`The ankh refused from ${position().x},${position().y},${position().z}: cliloc ${refusal.cliloc}`);
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
            (m) => m.kind === 'mobile' && m.notoriety === 7 && m.position && distance(position(), m.position) <= 18
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
        if (!healer)
          log(
            `No healer in view near ${option.x},${option.y} from ${position().x},${position().y}; ${
              [...session.world.entities.values()].filter((m) => m.kind === 'mobile').length
            } mobiles seen`
          );
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
          // The healer waits two seconds between offers (BaseHealer.ResurrectDelay), so with other
          // ghosts crowding it a crossing can go unanswered: up to 25 tries, each stepping back out
          // and in, toggling war mode (a ghost in war mode is visible) and double-clicking the healer.
          for (let pass = 0; pass < 25 && !offer() && isGhost(ctx); pass++) {
            if (pass) {
              const now = session.world.entities.get(healer.serial)?.position ?? at;
              const away = ctx.terrain.stand(now.x + (position().x >= now.x ? 4 : -4), now.y, position().z);
              if (away) await navigate(away, 0).catch(() => {});
              await Bun.sleep(1000 + Math.random() * 2000);
            }
            session.setWarMode(true);
            await Bun.sleep(300);
            session.setWarMode(false);
            session.use(healer.serial);
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
  // Old death robes out of the pack, and this one off as soon as there is something else to wear.
  const pack = session.world.childrenOf(ctx.serial).find((item) => item.layer === Layer.Backpack)?.serial;
  if (pack !== undefined) await tidyPack(session, pack, log, ctx.terrain).catch(() => {});
  // A few hit points after resurrection: healed first, or the first blow kills it again (mend.ts).
  if (pack !== undefined) await mendAfterDeath({ ...ctx, backpack: () => pack }, log);
  // Dying again and again where it stands: out through the Help menu, home (stuck.ts).
  noteDeath(session);
  if (dyingOverAndOver(session)) {
    const city = 'city' in ctx && typeof ctx.city === 'string' ? ctx.city : 'Britain';
    if (await useStuckMenu(ctx, city, 'I keep dying here')) return;
  }
  if (recoverCorpse) await recoverOwnCorpse(ctx, fell, diedAt);
}
