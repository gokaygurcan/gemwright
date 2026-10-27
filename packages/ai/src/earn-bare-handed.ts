import { knownBankGold } from './bank-gold';
import type { CharacterTemplate } from './config';
import { info } from './log';
import type { PlayerSession } from './protocol/session';
import { jobReady, observeBackpack } from './self';
import type { Checkpoint } from './store';

// A trade that needs a tool it has not got and cannot afford earns the money bare-handed, as a
// fighter on prey weak enough for fists (fight cost counts them), in spells of up to fifteen
// minutes, looking again after each. No begging and no waiting: neither buys a tool. Returns the
// seconds left for its own work.
export async function earnBareHanded(
  session: PlayerSession,
  template: CharacterTemplate,
  checkpoint: Checkpoint,
  seconds: number,
  stopping: () => boolean,
  hunt: (seconds: number) => Promise<unknown>
): Promise<number> {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    await observeBackpack(session);
    const job = jobReady(session, template);
    const funds = (session.world.status?.gold ?? 0) + knownBankGold(checkpoint);
    if (job.ready || funds >= job.price || Date.now() >= until - 60_000 || stopping()) break;
    info(
      `[earn] ${session.world.entities.get(session.world.serial ?? -1)?.name ?? 'resident'}: no ${job.what} and ${funds} gold; hunting bare-handed to earn it`
    );
    await hunt(Math.min(900, (until - Date.now()) / 1000)).catch((error) => {
      if (session.phase !== 'ready') throw error;
    });
  }
  return Math.max(0, (until - Date.now()) / 1000);
}
