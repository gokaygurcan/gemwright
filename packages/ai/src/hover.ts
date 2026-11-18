import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

import type { Mind } from './mind';
import { screenOf } from './perceive';

// Its own things looked at closely as they come into view (their hover: weight, what makes a piece
// good), worn, carried, and in its bank box while it is open: one at a time, a few a second, between
// the steps of its plans (never in the middle of one, never holding one up), as a player mouses over
// its pack (ores and ingots look alike until then). Each is asked about until it answers.
// Hair, beards and faces are no things the shard can describe (ServUO gives them made-up serials).
const bodily: ReadonlySet<number> = new Set([Layer.Hair, Layer.FacialHair, Layer.Face]);
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
  // What did not answer waits until everything else has been asked once.
  const unanswered = new Set<number>();
  // What lies in a bank box can be looked at only while the box is open (until its next step).
  const reachable = (serial: number) => {
    for (let at = screen.entities.get(serial), hops = 0; at && hops < 16; hops++) {
      if (at.layer === Layer.Bank && at.parent === screen.serial) return screen.shown.has(at.serial);
      at = at.parent === undefined ? undefined : screen.entities.get(at.parent);
    }
    return true;
  };
  while (!stopping() && session.phase === 'ready') {
    if (busy()) {
      await Bun.sleep(pause);
      continue;
    }
    for (const serial of unanswered)
      if (!screen.entities.has(serial)) {
        unanswered.delete(serial);
        asked.delete(serial);
      }
    const unasked = (serial: number) => !asked.has(serial) && !unanswered.has(serial);
    // Its own things first; then the people about, whose hover names their trade (a vendor's title).
    const next =
      [...mind.belongings().keys()].find((serial) => {
        const item = screen.entities.get(serial);
        return (
          item?.kind === 'item' &&
          !item.properties &&
          !bodily.has(item.layer ?? -1) &&
          unasked(serial) &&
          reachable(serial)
        );
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
    await session.inspectProperties(next).catch(() => {
      // A bank box closed by a step meanwhile: asked again the next time it is open.
      if (reachable(next)) unanswered.add(next);
      else asked.delete(next);
    });
    await Bun.sleep(pause);
  }
}
