import { TileFlag } from '@gemwright/common/assets/tiledata';
import { GHOST_BODIES, HUMAN_ELF_BODIES } from '@gemwright/common/game/bodies';
import { craftSystemOf, isA } from '@gemwright/common/game/rules';
import { Notoriety } from '@gemwright/network/opcodes';

import { bankBatch, bankSteps, byWay } from './banking';
import { equipmentToKeep, weaponSkill } from './inventory';
import { harvestBy, isKeepsake } from './knowledge';
import type { Mind } from './mind';
import type { Option } from './options';
import { craftSkill } from './self';
import type { Terrain } from './terrain';

const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export function recovery(mind: Mind): Option | undefined {
  const here = mind.position;
  if (!here) return;
  if (mind.care.needsHelp())
    return { key: 'ask for stuck help', urgent: true, value: 0, seconds: 130, steps: [{ verb: 'help' }] };
  if (GHOST_BODIES.has(mind.self.body ?? 0)) return;
  if (mind.care.mending && mind.self.health && mind.self.health.current < mind.self.health.max * 0.8)
    return { key: 'mend after death', urgent: true, value: 0, seconds: 3, steps: [{ verb: 'rest', seconds: 3 }] };
  const died = mind.care.corpse;
  if (!died || mind.care.corpseTried === died.at || died.map !== here.map || Date.now() - died.at >= 7 * 60_000) return;
  // Going back to the same place to die again never recovers anything.
  if (
    mind.care.deaths.filter(
      (d) =>
        d.map === died.map && d.x !== undefined && d.y !== undefined && away(d as { x: number; y: number }, died) < 40
    ).length > 1
  )
    return;
  const corpse = mind
    .has()
    .corpses.find(
      (c) => c.name === 'my Corpse' && c.x !== undefined && c.y !== undefined && away({ x: c.x, y: c.y }, died) <= 6
    );
  const destination = corpse?.x !== undefined && corpse.y !== undefined ? { x: corpse.x, y: corpse.y } : died;
  if (!mind.allowed(destination) || !mind.reachable(destination)) return;
  const distance = mind.steps?.(here, { ...destination, z: died.z }) ?? away(here, destination);
  if (Date.now() + distance * 1000 >= died.at + 7 * 60_000) return;
  return {
    key: 'recover my corpse',
    id: `recover corpse ${died.at}`,
    urgent: true,
    value: 0,
    seconds: 3,
    steps: [
      { verb: 'walk', ...destination, range: 2 },
      { verb: 'recover-corpse', ...(corpse ? { serial: corpse.serial } : {}) }
    ]
  };
}

export function scavenging(mind: Mind, terrain?: Terrain): Option[] {
  const here = mind.position;
  const room = mind.self.abilities().carries;
  if (!here || mind.pack === undefined || GHOST_BODIES.has(mind.self.body ?? 0)) return [];
  return mind.has().ground.flatMap<Option>((item) => {
    const sight = mind.sight(item.serial);
    if (
      !sight?.movable ||
      sight.fixed ||
      sight.parent !== undefined ||
      !sight.position ||
      away(here, item) > 2 ||
      Math.abs(here.z - item.z) > 10 ||
      mind.deathRobe(item.serial)
    )
      return [];
    if ((mind.care.cooldowns.get(`pickup ${item.serial}`) ?? 0) > Date.now()) return [];
    if (item.kind === 'container' || (item.name.split('/').some((t) => isA(t, 'BaseOre')) && mind.skill('Mining') < 30))
      return [];
    const valuable =
      item.worth > 0 ||
      isKeepsake(item.name) ||
      (sight.graphic !== undefined && !!((terrain?.tile?.(sight.graphic, true)?.flags ?? 0) & TileFlag.Wearable));
    if (!valuable) return [];
    const unit = item.weight === undefined ? mind.unitWeight(item.name) : item.weight / item.amount;
    if (unit === undefined && room !== undefined)
      return [
        {
          key: `inspect ground ${item.serial}`,
          value: mind.temper.curiosity,
          seconds: 1,
          steps: [{ verb: 'inspect' as const, serial: item.serial }]
        }
      ];
    const amount = Math.min(item.amount, unit ? Math.max(0, Math.floor((room ?? Infinity) / unit)) : item.amount);
    if (!amount) return [];
    return [
      {
        key: `pick-up ${item.name}`,
        id: `pickup ${item.serial}`,
        loads: amount * (unit ?? 0),
        value: mind.cost((item.worth * amount) / item.amount) * (1 - mind.temper.honesty),
        seconds: 1,
        steps: [{ verb: 'pickup' as const, serial: item.serial, amount }]
      }
    ];
  });
}

export function guards(mind: Mind): Option | undefined {
  const here = mind.position;
  const own = mind.self.notoriety;
  if (
    !here ||
    !(mind.here?.guarded ?? mind.guarded) ||
    GHOST_BODIES.has(mind.self.body ?? 0) ||
    own === Notoriety.criminal ||
    own === Notoriety.murderer
  )
    return;
  const offender = [...mind.sights()].find(
    (e) =>
      e.kind === 'mobile' &&
      e.position &&
      HUMAN_ELF_BODIES.has(e.graphic ?? 0) &&
      (e.notoriety === Notoriety.criminal || e.notoriety === Notoriety.murderer) &&
      away(here, e.position) <= 12 &&
      (mind.care.cooldowns.get(`guards ${e.serial}`) ?? 0) <= Date.now()
  );
  if (!offender) return;
  return {
    key: 'call guards',
    urgent: true,
    value: mind.temper.boldness,
    seconds: 1,
    steps: [{ verb: 'guards', serial: offender.serial }]
  };
}

export function mountCare(mind: Mind, vendors: readonly { x: number; y: number; types: string[] }[]): Option[] {
  const here = mind.position;
  if (
    !here ||
    !mind.care.rode ||
    mind.riding ||
    (mind.mount !== undefined && mind.sight(mind.mount)) ||
    mind.self.followers?.current !== 0 ||
    Date.now() < mind.care.claimAfter
  )
    return [];
  const seen = [...mind.sights()].flatMap((e) =>
    e.position && mind.call(e.serial)?.split('/').includes('AnimalTrainer')
      ? [{ ...e.position, types: ['AnimalTrainer'] }]
      : []
  );
  return byWay(mind.steps, here, here.map, [...seen, ...vendors.filter((v) => v.types.includes('AnimalTrainer'))])
    .slice(0, 1)
    .map((at) => ({
      key: 'claim missing mount',
      value: mind.cost(500),
      seconds: 4,
      steps: [{ verb: 'walk', x: at.x, y: at.y, range: 2 }, { verb: 'claim' }]
    }));
}

export function insurance(mind: Mind, bankers: readonly { x: number; y: number }[]): Option[] {
  const here = mind.position;
  if (!here || mind.pack === undefined) return [];
  const tools = [...mind.belongings()].filter(([, item]) => {
    const harvest = harvestBy(item.name);
    if (harvest && mind.inTrade(harvest.skill)) return true;
    const weapon = weaponSkill(item.name);
    if (weapon && mind.inTrade(weapon)) return true;
    return item.name.split('/').some((type) => {
      const system = craftSystemOf(type);
      return (
        (system && mind.inTrade(craftSkill[system] ?? '')) ||
        (isA(type, 'BaseInstrument') &&
          ['Provocation', 'Peacemaking', 'Discordance'].some((skill) => mind.inTrade(skill)))
      );
    });
  });
  const stored = tools.find(([id]) => mind.banked(id));
  const carried = tools.filter(([id]) => mind.carrying(id));
  if (!carried.length && stored) {
    const batch = bankBatch(mind, [{ serial: stored[0], amount: 1 }]);
    const steps = batch && bankSteps(mind, bankers, batch.batch);
    return steps
      ? [
          {
            key: 'retrieve spare tool',
            id: `retrieve spare ${stored[0]}`,
            value: mind.cost(mind.worthOf(stored[0])) + mind.temper.diligence,
            seconds: 3,
            loads: batch?.weight,
            steps
          }
        ]
      : [];
  }
  if (stored || carried.length < 2 || mind.bankCapacity.count >= mind.bankCapacity.max) return [];
  const spare = carried.findLast(([id]) => mind.sight(id)?.parent === mind.pack);
  const bank = byWay(
    mind.steps,
    here,
    here.map,
    bankers.filter((at) => away(here, at) <= 12)
  )[0];
  if (!spare || !bank) return [];
  return [
    {
      key: 'store spare tool',
      id: `insure ${spare[0]}`,
      value: mind.cost(mind.worthOf(spare[0])),
      seconds: 3,
      consumes: [spare[0]],
      steps: [
        { verb: 'walk', ...bank, range: 3 },
        { verb: 'say', text: 'bank' },
        { verb: 'deposit', items: [spare[0]] }
      ]
    }
  ];
}

export function bankRoom(mind: Mind, bankers: readonly { x: number; y: number }[], terrain?: Terrain): Option[] {
  if (mind.bankCapacity.count < mind.bankCapacity.max || !mind.position) return [];
  const keep = equipmentToKeep(mind, terrain, true);
  const spare = mind
    .has()
    .bank.find(
      (i) =>
        !keep.has(i.serial) &&
        i.kind !== 'container' &&
        !i.name.split('/').some((t) => t === 'Gold' || isA(t, 'BaseIngot') || isA(t, 'BaseOre')) &&
        !harvestBy(i.name) &&
        (i.weight ?? Infinity) <= (mind.self.abilities().carries ?? Infinity)
    );
  const bank = byWay(mind.steps, mind.position, mind.position.map, bankers)[0];
  if (!spare || !bank) return [];
  return [
    {
      key: 'clear bank room',
      urgent: true,
      id: `clear bank ${spare.serial}`,
      value: 0,
      seconds: 3,
      loads: spare.weight,
      steps: [
        { verb: 'walk', ...bank, range: 3 },
        { verb: 'say', text: 'bank' },
        { verb: 'clear-bank', serial: spare.serial }
      ]
    }
  ];
}
