import { queryStatus } from './packets';
import type { WorldView } from './world';

export async function requestSkills(
  world: WorldView,
  send: (packet: Buffer) => void,
  waitFor: (predicate: () => boolean, label: string, timeoutMs: number) => Promise<void>
): Promise<void> {
  if (world.serial === null) throw new Error('Character serial unknown');
  const before = world.received.get(0x3a) ?? 0;
  const request = queryStatus(world.serial);
  request[5] = 5;
  send(request);
  await waitFor(
    () => (world.received.get(0x3a) ?? 0) > before && world.skills.size > 0,
    'observed character skills',
    3000
  );
}
