import { gumpCommands } from './protocol/gumps';
import type { PlayerSession } from './protocol/session';

// The Help menu's "My character is physically stuck" (ServUO HelpGump button 2, then StuckMenu):
// a choice of town, a wait of 10 seconds to 2 minutes frozen in place, then a teleport there. A
// player uses it when there is no way out on foot; the server allows two uses in 24 hours. A
// resident does the same when it keeps dying where it is (three deaths within the hour) or cannot
// walk to any moongate.
const TOWNS = ['Britain', 'Trinsic', 'Vesper', 'Minoc', 'Yew', 'Cove']; // StuckMenu buttons 1-6
const HELP_STUCK = 2;
const CHOOSE_TOWN = 1011027;
const DAY = 24 * 3_600_000;
const deaths = new Map<number, number[]>();
const uses = new Map<number, number[]>();

type Ctx = { session: PlayerSession; phase: (phase: string, note: string) => void; log: (message: string) => void };

export function noteDeath(session: PlayerSession) {
  const me = session.world.serial;
  if (me === null) return;
  deaths.set(me, [...(deaths.get(me) ?? []).filter((at) => Date.now() - at < 3_600_000), Date.now()]);
}

// No moongate within reach, again and again: walking out has failed.
const stranded = new Map<number, number[]>();
export function noteStranded(session: PlayerSession) {
  const me = session.world.serial ?? -1;
  stranded.set(me, [...(stranded.get(me) ?? []).filter((at) => Date.now() - at < 3_600_000), Date.now()]);
}
export const strandedOften = (session: PlayerSession) =>
  (stranded.get(session.world.serial ?? -1) ?? []).length >= 3 || dyingOverAndOver(session);

export function dyingOverAndOver(session: PlayerSession) {
  return (deaths.get(session.world.serial ?? -1) ?? []).filter((at) => Date.now() - at < 3_600_000).length >= 3;
}

const gumpWith = (session: PlayerSession, match: (commands: string[][]) => boolean) =>
  [...session.world.gumps.values()].find((gump) => match(gumpCommands(gump.layout)));

// True when it was moved to a town.
export async function useStuckMenu(ctx: Ctx, home: string, why: string): Promise<boolean> {
  const { session } = ctx;
  const me = session.world.serial;
  const from = session.world.position;
  if (me === null || !from || session.world.target) return false;
  const used = (uses.get(me) ?? []).filter((at) => Date.now() - at < DAY);
  if (used.length >= 2) return false;
  ctx.phase('stuck', `Asking for help: ${why}`);
  session.requestHelp();
  const help = await session
    .waitFor(
      () => !!gumpWith(session, (c) => c.some((x) => x[0] === 'button' && Number(x[7]) === HELP_STUCK)),
      'help menu',
      5000
    )
    .then(() => gumpWith(session, (c) => c.some((x) => x[0] === 'button' && Number(x[7]) === HELP_STUCK)))
    .catch(() => undefined);
  if (!help) return false;
  session.replyGump(help.serial, help.id, HELP_STUCK, []);
  const towns = await session
    .waitFor(
      () => !!gumpWith(session, (c) => c.some((x) => x[0]?.startsWith('xmfhtml') && Number(x[5]) === CHOOSE_TOWN)),
      'stuck menu',
      5000
    )
    .then(() => gumpWith(session, (c) => c.some((x) => x[0]?.startsWith('xmfhtml') && Number(x[5]) === CHOOSE_TOWN)))
    .catch(() => undefined);
  // No town list: the server refused (in combat, a criminal, or used twice today) and filed a page.
  if (!towns) {
    ctx.log(`Asked for help (${why}); the stuck menu was not offered`);
    return false;
  }
  const own = TOWNS.findIndex((town) => town.toLowerCase() === home.toLowerCase());
  const index = own >= 0 ? own : Math.floor(Math.random() * TOWNS.length);
  session.replyGump(towns.serial, towns.id, index + 1, []);
  uses.set(me, [...used, Date.now()]);
  const moved = () => {
    const at = session.world.position;
    return !!at && Math.max(Math.abs(at.x - from.x), Math.abs(at.y - from.y)) > 30;
  };
  await session.waitFor(moved, 'stuck teleport', 130_000).catch(() => {});
  ctx.log(
    moved()
      ? `Used the stuck menu (${why}); now in ${TOWNS[index]}`
      : `Chose ${TOWNS[index]} in the stuck menu (${why}) but was not moved`
  );
  return moved();
}
