import type { PlayerSession } from './protocol/session';

// Menus driven as a player clicks through them (house placement, the guild menus): a gump is
// recognised by a cliloc in its layout, the newest one first, and answered with one of its own
// buttons. Server messages are read from the journal by cliloc.
type Gump = PlayerSession['world']['gumps'] extends Map<string, infer G> ? G : never;

export function findGump(session: PlayerSession, cliloc: number): Gump | undefined {
  const token = new RegExp(`\\b${cliloc}\\b`);
  return [...session.world.gumps.values()].reverse().find((gump) => token.test(gump.layout));
}

export async function awaitGump(session: PlayerSession, cliloc: number, label: string, ms = 8000) {
  await session.waitFor(() => !!findGump(session, cliloc), label, ms);
  const gump = findGump(session, cliloc);
  if (!gump) throw new Error(`No ${label}`);
  return gump;
}

export function press(session: PlayerSession, gump: Gump, button: number, texts: { id: number; text: string }[] = []) {
  session.replyGump(gump.serial, gump.id, button, [], texts);
}

// Closes every open gump showing `cliloc` (button 0 is each menu's close or cancel).
export function dismiss(session: PlayerSession, cliloc: number) {
  for (let gump = findGump(session, cliloc); gump; gump = findGump(session, cliloc)) {
    try {
      press(session, gump, 0);
    } catch {
      session.world.gumps.delete(`${gump.serial}:${gump.id}`);
    }
  }
}

// A moment to listen from (the journal is capped, so by time, not position), and the first of
// `clilocs` the server sends after it.
export const mark = (_session: PlayerSession) => new Date().toISOString();
export const heardSince = (session: PlayerSession, from: string, clilocs: readonly number[]) =>
  session.world.journal
    .filter((entry) => entry.at >= from)
    .map((entry) => entry.cliloc)
    .find((cliloc): cliloc is number => cliloc !== undefined && clilocs.includes(cliloc));

export async function awaitMessage(
  session: PlayerSession,
  from: string,
  clilocs: readonly number[],
  label: string,
  ms = 8000
) {
  await session.waitFor(() => heardSince(session, from, clilocs) !== undefined, label, ms).catch(() => {});
  return heardSince(session, from, clilocs);
}
