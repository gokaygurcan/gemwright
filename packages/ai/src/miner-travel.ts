import { moongates, nearestGate, travelByMoongate } from './moongate';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
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
  // From anywhere else (a miner can end up far from home), through the public moongate nearest home.
  const gate = nearestGate(home);
  if (distance(position(), moongates[gate]) > 2) await travelByMoongate({ session, position, navigate, phase }, gate);
  phase('home-arrival', `Arrived through the ${gate} public moongate; heading into town`);
  await navigate(home, 5);
  checkpoint.mining = newTrip();
  phase('home-ready', 'Minoc is the current mining base');
}
