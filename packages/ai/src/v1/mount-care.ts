import { Stabling } from '@gemwright/network/replies';
import type { Entity } from '@gemwright/network/world';

import { serviceLocations } from './locations';
import type { MountContext, MountMemory } from './mount-types';

// ServUO AnimalTrainer.Claim replies: claimed, nothing stabled, too many followers.
const CLAIMED = Stabling.claimed;
const NONE_STABLED = Stabling.noneStabled;
const TOO_MANY = Stabling.tooManyFollowers;
export const MOUNT_TOO_ILL = 1049692;
const CLAIM_RETRY = 10 * 60_000;
// A silent or unanswerable trainer is not asked again for an hour: a walk for nothing, twice.
const CLAIM_BACKOFF = 60 * 60_000;

// A horse the server no longer counts as a follower is stabled (auto-stabled on logout where the
// region refuses auto-claim), released, or dead. A player asks the trainer before buying another.
export async function recoverMissingMount(
  ctx: MountContext,
  city: string,
  memory: MountMemory,
  discover: (excluded: readonly number[]) => Promise<Entity | undefined>
): Promise<boolean> {
  const { session, phase, persist, log, check } = ctx;
  if (memory.state !== 'missing' || (memory.claimAt ?? 0) > Date.now()) return false;
  await session.refreshStatus();
  const followers = ctx.status().followers;
  // Still a follower: the horse is alive somewhere; the last-seen search in ride() covers it.
  if (followers === undefined || followers > 0) return false;
  // Personal history before the walk: nothing was ever stabled for this resident, so the trainer has
  // nothing — the animal is lost (dead, released, wandered), not waiting at a stable.
  if (!memory.stabled) {
    memory.state = 'lost';
    memory.asked = { at: Date.now(), answer: 'none' };
    memory.note = 'My animal was never stabled; it is lost, and a replacement may be bought';
    delete memory.horse;
    delete memory.equipment;
    persist();
    log(memory.note);
    return false;
  }
  memory.claimAt = Date.now() + CLAIM_RETRY;
  persist();
  for (const stop of serviceLocations(city, 'animal-trainer').slice(0, 1)) {
    check();
    phase('mount-claim', `Asking the animal trainer near ${stop.name} for a stabled horse`);
    try {
      // A trainer answers a claim at arm's length; four tiles is out of earshot in practice.
      await ctx.navigate(stop, 2);
    } catch (error) {
      check();
      log(`Trainer unreachable: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const before = new Set(session.world.journal);
    const reply = () =>
      session.world.journal.find(
        (entry) => !before.has(entry) && [CLAIMED, NONE_STABLED, TOO_MANY].includes(entry.cliloc ?? 0)
      )?.cliloc;
    session.say('claim');
    try {
      await session.waitFor(() => reply() !== undefined, 'animal trainer claim reply', 4000);
    } catch {
      check();
      // Nothing came back (not a trainer, out of earshot, or busy): remember it and wait an hour
      // before asking anyone again, instead of walking to the next stop and back every ten minutes.
      memory.asked = { at: Date.now(), answer: 'silent' };
      memory.claimAt = Date.now() + CLAIM_BACKOFF;
      persist();
      log('The trainer did not answer a claim; not asking again for an hour');
      continue;
    }
    if (reply() === CLAIMED) {
      memory.asked = { at: Date.now(), answer: 'claimed' };
      delete memory.stabled;
      persist();
      await Bun.sleep(800);
      const horse = await discover([]);
      phase('mount-claimed', horse ? `Claimed stabled horse ${horse.serial}` : 'Claimed a stabled animal');
      return !!horse;
    }
    if (reply() === NONE_STABLED) {
      // Not stabled and no longer a follower: dead or released. A replacement is now legitimate.
      memory.state = 'lost';
      memory.asked = { at: Date.now(), answer: 'none' };
      memory.note = 'Horse is neither a follower nor stabled; a replacement may be bought when affordable';
      delete memory.horse;
      delete memory.equipment;
      delete memory.stabled;
      persist();
      log(memory.note);
      return false;
    }
    if (reply() === TOO_MANY) {
      memory.asked = { at: Date.now(), answer: 'too-many' };
      memory.claimAt = Date.now() + CLAIM_BACKOFF;
      persist();
      log('Stabled horse could not be claimed: too many followers');
      return false;
    }
    // No answer at all (not a trainer, out of earshot, or busy): an hour before asking again.
    memory.claimAt = Date.now() + CLAIM_BACKOFF;
    persist();
    log('The trainer did not answer a claim; not asking again for an hour');
    return false;
  }
  return false;
}
