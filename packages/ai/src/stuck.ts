import { lasting } from './lasting';
import { gumpCommands } from './protocol/gumps';
import type { PlayerSession } from './protocol/session';
import { noteTrouble } from './trouble';

// The Help menu's "My character is physically stuck" (ServUO HelpGump button 2, then StuckMenu):
// a choice of town, a wait of 10 seconds to 2 minutes frozen in place, then a teleport there. A
// player uses it when there is no way out on foot; the server allows two uses in 24 hours. A
// resident does the same when it keeps dying where it is (three deaths within the hour) or cannot
// walk to any moongate. Deaths and uses are kept across restarts (lasting.ts).
const TOWNS = ['Britain', 'Trinsic', 'Vesper', 'Minoc', 'Yew', 'Cove']; // StuckMenu buttons 1-6
const HELP_STUCK = 2;
const CHOOSE_TOWN = 1011027;
const DAY = 24 * 3_600_000;

type Ctx = { session: PlayerSession; phase: (phase: string, note: string) => void; log: (message: string) => void };

export function noteDeath(session: PlayerSession) {
  const me = session.world.serial;
  if (me === null) return;
  lasting('deaths', me).set(Date.now(), Date.now() + 3_600_000);
}

// No moongate within reach, again and again: walking out has failed.
export function noteStranded(session: PlayerSession) {
  lasting('stranded', session.world.serial ?? -1).set(Date.now(), Date.now() + 3_600_000);
}
export const strandedOften = (session: PlayerSession) =>
  lasting('stranded', session.world.serial ?? -1).count() >= 3 || dyingOverAndOver(session);

export function dyingOverAndOver(session: PlayerSession) {
  return lasting('deaths', session.world.serial ?? -1).count() >= 3;
}

const gumpWith = (session: PlayerSession, match: (commands: string[][]) => boolean) =>
  [...session.world.gumps.values()].find((gump) => match(gumpCommands(gump.layout)));

// True when it was moved to a town.
export async function useStuckMenu(ctx: Ctx, home: string, why: string): Promise<boolean> {
  const { session } = ctx;
  const me = session.world.serial;
  const from = session.world.position;
  if (me === null || !from || session.world.target) return false;
  if (lasting('stuck-menu', me).count() >= 2) return false;
  // One ask per half hour, whatever came of the last one: a refusal must not become a loop.
  const asked = lasting('stuck-ask', me);
  if (asked.active('last')) return false;
  asked.set('last', Date.now() + 30 * 60_000);
  ctx.phase('stuck', `Asking for help: ${why}`);
  noteTrouble(from, 'stuck');
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
  // A gump can close between being seen and being answered (another gump took its place).
  const reply = (serial: number, id: number, button: number) => {
    try {
      session.replyGump(serial, id, button, []);
      return true;
    } catch {
      return false;
    }
  };
  if (!reply(help.serial, help.id, HELP_STUCK)) return false;
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
  if (!reply(towns.serial, towns.id, index + 1)) return false;
  lasting('stuck-menu', me).set(Date.now(), Date.now() + DAY);
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
