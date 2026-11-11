import { graphicsOf } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import type { Hands } from './hands';

// The resurrection the shard offers a ghost (ServUO ResurrectGump: "It is possible for you to be
// resurrected...", 1011022), whoever offers it: a healer, an ankh, or a person's bandage or spell.
// Its first button accepts.
const offered = '1011022';
// Ankhs a ghost may use (ServUO Ankhs.cs: AnkhWest and AnkhNorth, plain or bloodied).
const ankhGraphics: ReadonlySet<number> = new Set([...graphicsOf('AnkhWest'), ...graphicsOf('AnkhNorth')]);
const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export type Shrine = { kind: 'healer' | 'ankh'; x: number; y: number };

// Dead, as a player is: whatever resurrection is offered is taken. Otherwise to the nearest healer in
// view, else the nearest healer or ankh the shard places that has not lately been tried in vain. A
// healer offers when a ghost comes near (BaseHealer), an ankh when a ghost steps beside it or uses it
// (Ankhs.cs). One that offers nothing waits its turn while the others are tried.
export async function rebirth(
  session: PlayerSession,
  hands: Hands,
  shrines: readonly Shrine[],
  call: (serial: number) => string | undefined,
  tried: Map<string, number>,
  stopping: () => boolean
) {
  const world = session.world;
  const offer = () => [...world.gumps.values()].find((gump) => gump.layout.includes(offered));
  const accept = async () => {
    const gump = offer();
    if (!gump) return false;
    session.replyGump(gump.serial, gump.id, 1, []);
    await Bun.sleep(2000);
    return true;
  };
  if (await accept()) return;
  const here = world.position;
  if (!here) return void (await Bun.sleep(2000));
  const going = () => !stopping() && !offer();
  const healer = [...world.entities.values()]
    .filter(
      (e) =>
        e.kind === 'mobile' &&
        e.position &&
        call(e.serial)
          ?.split('/')
          .some((n) => n.endsWith('Healer'))
    )
    .sort((a, b) => away(here, a.position ?? here) - away(here, b.position ?? here))[0];
  const now = Date.now();
  const place = healer?.position
    ? { kind: 'healer' as const, x: healer.position.x, y: healer.position.y }
    : [...shrines]
        .filter((s) => (tried.get(`${s.x},${s.y}`) ?? 0) < now)
        .sort((a, b) => away(here, a) - away(here, b))[0];
  if (!place) return void (await Bun.sleep(5000));
  await hands.do({ verb: 'walk', x: place.x, y: place.y, range: place.kind === 'ankh' ? 1 : 3 }, going);
  if (place.kind === 'ankh' && !offer()) {
    const ankh = [...world.entities.values()].find(
      (e) => ankhGraphics.has(e.graphic) && e.position && away(e.position, place) <= 1
    );
    if (ankh) session.use(ankh.serial);
  }
  for (const end = Date.now() + 4000; Date.now() < end && !offer(); ) await Bun.sleep(250);
  if (!(await accept())) tried.set(`${place.x},${place.y}`, Date.now() + 10 * 60_000);
}
