import type { PlayerSession } from '@gemwright/network/session';

import { logger } from '../log';
import type { Mind } from './mind';
import { screenOf } from './perceive';

// Its own things looked at closely as they come into view (their hover: weight, what makes a piece
// good), worn, carried, and in its bank box while it is open: one at a time, a few a second, between
// the steps of its plans (never in the middle of one, never holding one up), as a player mouses over
// its pack (ores and ingots look alike until then). Each is asked about until it answers.
export async function hover(
  session: PlayerSession,
  mind: Mind,
  stopping: () => boolean,
  asked: Set<number>,
  // Whether its hands are at a plan now.
  busy: () => boolean = () => false,
  pause = 300
) {
  const screen = screenOf(session);
  // What did not answer waits until everything else has been asked once (hair answers nothing),
  // rather than holding up the rest.
  const unanswered = new Set<number>();
  while (!stopping() && session.phase === 'ready') {
    if (busy()) {
      await Bun.sleep(pause);
      continue;
    }
    const unasked = (serial: number) => !asked.has(serial) && !unanswered.has(serial);
    // Its own things first; then the people about, whose hover names their trade (a vendor's title).
    const next =
      [...mind.belongings().keys()].find((serial) => {
        const item = screen.entities.get(serial);
        return item?.kind === 'item' && !item.properties && unasked(serial);
      }) ??
      [...screen.entities.values()].find(
        (e) =>
          e.kind === 'mobile' &&
          e.serial !== screen.serial &&
          !e.properties &&
          unasked(e.serial) &&
          mind.call(e.serial)?.split('/').includes('Person')
      )?.serial;
    if (next === undefined) {
      for (const serial of unanswered) asked.delete(serial);
      unanswered.clear();
      await Bun.sleep(pause * 3);
      continue;
    }
    asked.add(next);
    await session.inspectProperties(next).catch((error: Error) => {
      unanswered.add(next);
      logger('v2').info(`[v2] no hover for ${next}: ${error.message}`);
    });
    await Bun.sleep(pause);
  }
}
