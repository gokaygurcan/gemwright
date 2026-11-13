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
  while (!stopping() && session.phase === 'ready') {
    if (busy()) {
      await Bun.sleep(pause);
      continue;
    }
    const next = [...mind.belongings().keys()].find((serial) => {
      const item = screen.entities.get(serial);
      return item?.kind === 'item' && !item.properties && !asked.has(serial);
    });
    if (next === undefined) {
      await Bun.sleep(pause * 3);
      continue;
    }
    asked.add(next);
    await session.inspectProperties(next).catch((error: Error) => {
      // Unanswered, it is looked at again later, as a player mouses over it once more.
      asked.delete(next);
      logger('v2').info(`[v2] no hover for ${next}: ${error.message}`);
    });
    await Bun.sleep(pause);
  }
}
