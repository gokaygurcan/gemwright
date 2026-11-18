import { graphicsOf } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import { byWay } from './banking';
import type { Hands } from './hands';
import { screenOf } from './perceive';
import type { Steps } from './ventures';

// The resurrection the shard offers a ghost (ServUO ResurrectGump: "It is possible for you to be
// resurrected...", 1011022), whoever offers it: a healer, an ankh, or a person's bandage or spell.
// Its first button accepts.
const offered = '1011022';
// Ankhs a ghost may use (ServUO Ankhs.cs: AnkhWest and AnkhNorth, plain or bloodied).
const ankhGraphics: ReadonlySet<number> = new Set([...graphicsOf('AnkhWest'), ...graphicsOf('AnkhNorth')]);
const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export type Shrine = { kind: 'healer' | 'ankh'; x: number; y: number };

// Dead, as a player is: a ghost fears nothing, and its one aim is to live again. Nothing can harm
// it, so it always tries the way, whatever its memory says of it. Whatever
// resurrection is offered is taken. Otherwise it goes straight to the nearest healer or ankh by the
// way there (one in view, or one the shard places that has not lately failed it). A healer offers
// when a ghost steps within two tiles of it from farther off, at most every two seconds (ServUO
// BaseHealer.OnMovement): it walks into that reach, and if no offer comes, out and in again. An ankh
// offers when it is used from within two tiles (Ankhs.Resurrect). A place is given up only after it
// failed three times, and then only for the next one in turn.
export async function rebirth(
  session: PlayerSession,
  hands: Hands,
  shrines: readonly Shrine[],
  call: (serial: number) => string | undefined,
  tried: Map<string, number>,
  stopping: () => boolean,
  steps?: Steps
): Promise<string | undefined> {
  const world = screenOf(session);
  const offer = () => [...world.gumps.values()].find((gump) => gump.layout.includes(offered));
  const accept = async () => {
    const gump = offer();
    if (!gump) return false;
    session.replyGump(gump.serial, gump.id, 1, []);
    await Bun.sleep(2000);
    return true;
  };
  const answered = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end && !offer(); ) await Bun.sleep(250);
    return accept();
  };
  if (await accept()) return;
  const here = world.position;
  // Not knowing where it stands, it asks the shard, as a client resyncs.
  if (!here) {
    await session.resyncPosition();
    return 'not knowing where it stands';
  }
  const going = () => !stopping() && !offer();
  const healers = () =>
    [...world.entities.values()].filter(
      (e) =>
        e.kind === 'mobile' &&
        e.position &&
        call(e.serial)
          ?.split('/')
          .some((n) => n.endsWith('Healer'))
    );
  const now = Date.now();
  const inView = healers().map((e) => ({ kind: 'healer' as const, x: e.position?.x ?? 0, y: e.position?.y ?? 0 }));
  // Every healer and ankh is always somewhere to go: the one it tried least lately first, and among
  // those the nearest by the way there, then the nearest as the crow flies. Nothing is ever ruled out.
  const all = [...inView, ...shrines];
  const walked = byWay(steps, here, world.map, all);
  const place = [...walked, ...byWay(undefined, here, world.map, all).filter((p) => !walked.includes(p))].sort(
    (a, b) => (tried.get(`${a.x},${a.y}`) ?? 0) - (tried.get(`${b.x},${b.y}`) ?? 0)
  )[0];
  // Knowing of none at all, it searches: out a screen's walk in turn each way until one is in view.
  if (!place) {
    const [dx, dy] = (
      [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1]
      ] as const
    )[Math.floor(now / 60_000) % 4] ?? [1, 0];
    await hands.do({ verb: 'walk', trying: true, x: here.x + dx * 18, y: here.y + dy * 18, range: 2 }, going);
    return 'no healer or ankh known anywhere: searching';
  }
  const key = `${place.x},${place.y}`;
  for (let attempt = 0; attempt < 3 && going(); attempt++) {
    if (place.kind === 'ankh') {
      await hands.do({ verb: 'walk', trying: true, x: place.x, y: place.y, range: 1 }, going);
      if (!offer()) {
        const ankh = [...world.entities.values()].find(
          (e) => ankhGraphics.has(e.graphic) && e.position && away(e.position, place) <= 2
        );
        if (ankh) session.use(ankh.serial);
      }
      if (await answered(3000)) return;
      continue;
    }
    // To where the healer keeps, until one is in sight.
    const near = () => healers().find((e) => e.position && away(e.position, place) <= 12);
    if (!near())
      await hands.do({ verb: 'walk', trying: true, x: place.x, y: place.y, range: 2 }, () => going() && !near());
    const healer = near() ?? healers()[0];
    const at = healer?.position;
    if (!healer || !at) {
      if (await answered(2000)) return;
      continue;
    }
    // Already within its reach: out of it first, so the step back in is one the healer sees.
    const me = world.position ?? here;
    if (away(me, at) <= 2) {
      const dx = Math.sign(me.x - at.x) || 1;
      const dy = Math.sign(me.y - at.y);
      await hands.do({ verb: 'walk', trying: true, x: at.x + dx * 4, y: at.y + dy * 4, range: 0 }, going);
    }
    await hands.do({ verb: 'walk', trying: true, x: at.x, y: at.y, range: 1 }, going);
    if (await answered(3000)) return;
  }
  if (await accept()) return;
  tried.set(key, Date.now());
  return `no resurrection at the ${place.kind} at ${key} yet; trying the next`;
}
