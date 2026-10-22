import { serviceLocations } from './locations';
import type { MountContext, MountMemory } from './mount-types';
import type { Entity } from './protocol/world';

// ServUO AnimalTrainer.Claim replies: claimed, nothing stabled, too many followers.
const CLAIMED = 1042559;
const NONE_STABLED = 502671;
const TOO_MANY = 1049612;
export const MOUNT_TOO_ILL = 1049692;
const CLAIM_RETRY = 10 * 60_000;

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
  memory.claimAt = Date.now() + CLAIM_RETRY;
  persist();
  for (const stop of serviceLocations(city, 'animal-trainer')) {
    check();
    phase('mount-claim', `Asking the animal trainer near ${stop.name} for a stabled horse`);
    try {
      await ctx.navigate(stop, 4);
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
      continue;
    }
    if (reply() === CLAIMED) {
      await Bun.sleep(800);
      const horse = await discover([]);
      phase('mount-claimed', horse ? `Claimed stabled horse ${horse.serial}` : 'Claimed a stabled animal');
      return !!horse;
    }
    if (reply() === NONE_STABLED) {
      // Not stabled and no longer a follower: dead or released. A replacement is now legitimate.
      memory.state = 'lost';
      memory.note = 'Horse is neither a follower nor stabled; a replacement may be bought when affordable';
      delete memory.horse;
      delete memory.equipment;
      persist();
      log(memory.note);
      return false;
    }
    log('Stabled horse could not be claimed: too many followers');
    return false;
  }
  return false;
}
