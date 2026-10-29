import { expect, spyOn, test } from 'bun:test';

import { runProfession } from '../src/profession';
import { Terrain } from '../src/terrain';
import { socialFixture } from './social-fixture';

test('a shared plan that consumes a turn without progress cannot spin the profession loop', async () => {
  const f = socialFixture('tailor');
  f.template.creation = {
    namePrefix: 'Test',
    city: 'Britain',
    skills: { Tailoring: 50 },
    equipment: [],
    provisioning: 'normal-character-creation'
  };
  f.template.behavior.activities = ['tailor'];
  f.template.behavior.trainingGoals = {};
  f.terrain.findStatics = () => [];
  f.session.refreshStatus = async () => {};
  f.session.refreshSkills = async () => {};
  f.session.use = () => {
    f.world.received.set(0x3c, (f.world.received.get(0x3c) ?? 0) + 1);
  };
  f.world.entities.set(12, { serial: 12, kind: 'item', graphic: 0xf9d, parent: 10 });
  f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0x2258, parent: 10 });
  const terrain = spyOn(Terrain, 'shared').mockReturnValue(f.terrain);
  let orders = 0;
  try {
    await runProfession(
      'tailor',
      {
        session: f.session,
        template: f.template,
        assets: 'fixture',
        checkpoint: f.checkpoint,
        seconds: 0.2,
        save: () => {}
      },
      async () => {
        throw new Error('Accepted order must own the turn');
      },
      undefined,
      {
        order: async () => {
          orders++;
          return true;
        }
      }
    );
    expect(orders).toBe(1);
  } finally {
    terrain.mockRestore();
  }
});
