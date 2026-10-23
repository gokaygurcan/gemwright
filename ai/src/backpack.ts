import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';

// Opens the character's own backpack so its contents are observed, and returns its serial. A
// double-click can be refused while another action is under way, so it is tried up to three
// times; a final failure names the server's replies (a ghost hears "I am dead and cannot do that").
export async function openOwnBackpack(session: PlayerSession): Promise<number> {
  const backpack = [...session.world.entities.values()].find(
    (item) => item.parent === session.world.serial && item.layer === Layer.Backpack
  );
  if (!backpack) throw new Error('No observed backpack');
  for (let tries = 1; ; tries++) {
    const before = session.world.received.get(0x3c) ?? 0;
    const heard = new Set(session.world.journal);
    session.use(backpack.serial);
    const shown = () => (session.world.received.get(0x3c) ?? 0) > before;
    await session.waitFor(shown, 'backpack contents', 4000).catch((e) => {
      if (tries < 3) return;
      const replies = session.world.journal.filter((j) => !heard.has(j)).map((j) => j.cliloc ?? j.text);
      throw new Error(`${e instanceof Error ? e.message : e} (replies: ${replies.join(', ')})`);
    });
    if (shown()) return backpack.serial;
    await Bun.sleep(1500);
  }
}
