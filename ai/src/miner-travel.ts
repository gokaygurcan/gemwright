import type { MountContext } from './mount-types';
import { distance } from './navigation';
import { minocDestination } from './protocol/gumps';
import type { Checkpoint } from './store';

export async function travelMinerHome(
  ctx: Pick<MountContext, 'session' | 'position' | 'navigate' | 'phase' | 'checkpoint'> & {
    city: string;
    home: { x: number; y: number };
    newTrip: () => NonNullable<Checkpoint['mining']>;
  }
) {
  const { session, position, navigate, phase, checkpoint, city, home, newTrip } = ctx;

  if (distance(position(), home) < 350) {
    if (city === 'minoc' && distance(position(), home) > 150) {
      phase('home-arrival', 'In the Minoc region; heading into town before choosing a mine');
      await navigate(home, 5);
    }
    return;
  }
  if (city !== 'minoc' || distance(position(), { x: 1600, y: 1700 }) > 800)
    throw new Error('No ordinary travel route configured from the current region to the miner home');
  phase('home-travel', 'Relocating to Minoc through the Britain public moongate');
  await navigate({ x: 1336, y: 1997 }, 1);
  const gate = [...session.world.entities.values()].find(
    (item) => item.graphic === 0x0f6c && item.position && distance(position(), item.position) <= 1
  );
  if (!gate) throw new Error('Britain public moongate is not observed nearby');
  session.use(gate.serial);
  await session.waitFor(
    () => [...session.world.gumps.values()].some((gump) => minocDestination(gump.layout) !== undefined),
    'public moongate destinations'
  );
  const gump = [...session.world.gumps.values()].find((item) => minocDestination(item.layout) !== undefined);
  if (!gump) throw new Error('Minoc was not offered on the Trammel moongate page');
  const choice = minocDestination(gump.layout);
  if (choice === undefined) throw new Error('Minoc destination disappeared');
  session.replyGump(gump.serial, gump.id, 1, [choice]);
  await session.waitFor(
    () => distance(position(), { x: 2701, y: 692 }) <= 2 && session.world.map === 1,
    'arrival at Minoc moongate'
  );
  phase('home-arrival', 'Arrived through the Minoc public moongate; heading into town');
  await navigate(home, 5);
  checkpoint.mining = newTrip();
  phase('home-ready', 'Minoc is the current mining base');
}
