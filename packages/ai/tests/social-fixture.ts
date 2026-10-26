import { registerResident, registerTerrain } from '../src/resident-context';
import { behaviorFixture } from './behavior-fixture';

export function socialFixture(profession = 'tailor') {
  const f = behaviorFixture(profession);
  f.template.behavior.cooperation = 0.8;
  const spoken: string[] = [];
  f.session.say = (line) => {
    spoken.push(line);
  };
  f.session.party = () => {};
  f.session.inspectProperties = async () => {};
  f.session.waitFor = async (predicate) => {
    if (!predicate()) throw new Error('No server confirmation');
  };
  f.session.acceptTrade = (accepted = true) => {
    if (f.world.trade) f.world.trade.accepted.me = accepted;
  };
  f.session.cancelTrade = () => {
    if (f.world.trade) f.world.trade.closed = true;
  };
  registerResident(f.ctx);
  registerTerrain(f.session, f.terrain);
  return { ...f, spoken };
}
