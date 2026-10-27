import { gold } from '@gemwright/common/items';

import { cemeteries } from './cemeteries';
import type { CharacterTemplate } from './config';
import { activityLine } from './conversation-facts';
import type { DecisionCoordinator } from './decisions';
import { type Intent, intents } from './dialogue';
import { quoteTo } from './engagement';
import { askGuide } from './guide';
import { learnQuality } from './item-quality';
import { lasting } from './lasting';
import { type ServiceType, serviceLocations } from './locations';
import { carriedOf, ceiling, floor, type Good, goods, priceAt } from './market';
import { moongates, nearestGate } from './moongate';
import { distance } from './navigation';
import { readTradeTalk } from './player-trade';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Checkpoint } from './store';
import { orderDemand } from './work-orders';
import { professionOf } from './world';

const places: Record<string, ServiceType> = {
  bank: 'banker',
  healer: 'healer',
  smith: 'blacksmith',
  blacksmith: 'blacksmith',
  stable: 'animal-trainer',
  stables: 'animal-trainer'
};
const compass = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const directions = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const angle = Math.atan2(to.x - from.x, -(to.y - from.y));
  const index = Math.round(((angle * 180) / Math.PI + 360) / 45) % 8;
  const far = distance(from, to);
  return far < 6 ? 'right here' : `about ${Math.round(far / 5) * 5} paces ${compass[index]}`;
};

// Answers that need the world: directions, a help judgement, and the follow refusal.
export async function worldAnswer(
  options: {
    session: PlayerSession;
    checkpoint: Checkpoint;
    template: CharacterTemplate;
    city: string;
    decisions?: DecisionCoordinator;
  },
  intent: Intent,
  name: string,
  text: string,
  here: { x: number; y: number }
): Promise<string | undefined> {
  const { checkpoint, template, city, session, decisions } = options;
  switch (intent) {
    case 'trade':
      return tradeReply(session, template, name, text);
    case 'follow':
      return `I cannot leave my work, ${name}.`;
    case 'where': {
      const asked = text.match(intents.where.pattern ?? /$^/)?.[1]?.toLowerCase() ?? '';
      if (/mine/.test(asked) && city.toLowerCase() === 'minoc')
        return `The mines? Thou shouldst find them ${directions(here, { x: 2560, y: 500 })}.`;
      if (/graveyard|cemetery/.test(asked)) {
        const nearest = [...cemeteries].sort((a, b) => distance(here, a.center) - distance(here, b.center))[0];
        return nearest
          ? `The ${nearest.name} cemetery is ${directions(here, nearest.center)}. Beware the undead.`
          : undefined;
      }
      if (/gate/.test(asked)) {
        const gate = moongates[nearestGate(here)];
        return `The nearest moongate is ${directions(here, gate)}.`;
      }
      const service = places[asked];
      const spot = service
        ? [...serviceLocations(city, service), ...serviceLocations('Britain', service)].sort(
            (a, b) => distance(here, a) - distance(here, b)
          )[0]
        : undefined;
      return spot
        ? `The ${asked}? Thou shouldst find it ${directions(here, spot)}, near ${spot.name}.`
        : `I know not where to find the ${asked || 'place'} from here.`;
    }
    case 'guide': {
      const asked =
        text
          .match(intents.guide.pattern ?? /$^/)?.[1]
          ?.toLowerCase()
          .replace(/s$/, '') ?? '';
      const service = places[asked] ?? places[`${asked}s`];
      const spot = service
        ? [...serviceLocations(city, service)].sort((a, b) => distance(here, a) - distance(here, b))[0]
        : undefined;
      if (!spot || distance(here, spot) > 60 || /fight|engag/.test(checkpoint.goal?.phase ?? ''))
        return spot ? `The ${asked} is ${directions(here, spot)}.` : `I know not where the ${asked} is from here.`;
      askGuide(session, { to: spot, name, place: asked });
      return `Follow me, ${name}, I'll show thee.`;
    }
    case 'group': {
      const fighter =
        !!template.archetype &&
        /Swords|Fencing|Mace|Archery|Magery|Wrestling/.test(template.archetype.primarySkills.join(' '));
      return fighter && template.behavior.cooperation >= 0.4
        ? `Aye, ${name}, send me an invite.`
        : `I'm no fighter, ${name}, but good hunting.`;
    }
    case 'safe':
      return safetyAnswer(session, here, text);
    case 'help': {
      // A cooperation judgement: the provider weighs helping against what the resident is doing.
      const fighting = /fight|engag/.test(checkpoint.goal?.phase ?? '');
      const baseline = fighting || template.behavior.cooperation < 0.5 ? 'decline-busy' : 'offer-advice';
      const pick = decisions
        ? await decisions.choose({
            kind: 'help-request',
            checkpoint,
            state: {
              request: text.slice(0, 120),
              speaker: name,
              currentActivity: activityLine(checkpoint),
              note: 'This resident can talk and give directions, but cannot yet follow, escort, or trade.'
            },
            observationRevision: session.world.revision,
            baseline,
            stillCurrent: () => session.phase === 'ready',
            candidates: [
              {
                id: 'offer-advice',
                description: 'Offer directions and advice about town services.',
                valid: () => true
              },
              { id: 'decline-busy', description: 'Politely decline because of the current task.', valid: () => true }
            ]
          })
        : null;
      const choice = pick?.id ?? baseline;
      if (pick) decisions?.finish(checkpoint, pick, 'completed', `Answered a help request with ${choice}`);
      return choice === 'offer-advice'
        ? `What is it thou needest, ${name}? I can point thee to the bank, healer, smith, or the nearest cemetery.`
        : `Sorry, ${name}, ${fighting ? 'I am too busy fighting to deal with thee' : 'I am busy just now'}.`;
    }
    default:
      return undefined;
  }
}

// What a resident who stopped for a player says to trade talk (player-trade.ts reads the line).
// A player buying, or asking, gets a quote from the resident's carried market goods; their own
// price is taken when it beats the shop's buying price. A player selling what the resident uses
// (wantedBy) gets an offer within the resident's carried coins, countered when asked too much.
// Either way the agreed lot is remembered for that player's trade window (trade-guard.ts).
async function tradeReply(session: PlayerSession, template: CharacterTemplate, name: string, text: string) {
  const talk = (await readTradeTalk(text)) ?? { side: 'asking' as const };
  const partner = [...session.world.journal].reverse().find((e) => e.name === name)?.serial;
  const serial = session.world.serial;
  const pack = serial === null ? undefined : session.world.childrenOf(serial).find((i) => i.layer === Layer.Backpack);
  if (partner === undefined || !pack) return `I have naught to trade with thee, ${name}.`;
  await learnQuality(session, session.world.childrenOf(pack.serial));
  if (talk.side === 'selling') {
    const good = talk.good;
    if (!good || !wantedBy(template).includes(good)) return `I have no need of ${good ?? 'that'}, ${name}.`;
    const amount = talk.amount ?? goods[good].lot;
    const fair = priceAt(good, amount, 0.5);
    const asked = talk.price && talk.price <= ceiling(good, amount) ? talk.price : undefined;
    const price = asked ?? fair;
    const coins = goldCarried(session, pack.serial);
    if (coins < price) return `I carry but ${coins} gold, ${name}; not enough for ${amount} ${good}.`;
    quoteTo(session, partner, { side: 'buy', good, amount, price });
    return `${asked ? 'Agreed' : 'Too dear for me'}: ${amount} ${good} for ${price} gold. Open a trade with me if thou wilt.`;
  }
  const stock = (Object.keys(goods) as Good[])
    .map((good) => ({ good, have: Math.max(0, carriedOf(session, pack.serial, good) - orderDemand(session, good)) }))
    .filter((s) => s.have >= goods[s.good].lot && (!talk.good || s.good === talk.good))
    .sort((a, b) => b.have - a.have)[0];
  if (!stock) return `I have no ${talk.good ?? 'goods'} to sell thee, ${name}.`;
  const amount = Math.min(talk.amount ?? stock.have, stock.have);
  const price = talk.price && talk.price >= floor(stock.good, amount) ? talk.price : priceAt(stock.good, amount, 0.5);
  quoteTo(session, partner, { side: 'sell', good: stock.good, amount, price });
  return `I have ${stock.have} ${stock.good}; ${amount} for ${price} gold. Open a trade with me if thou wilt.`;
}

const goldCarried = (session: PlayerSession, pack: number) =>
  session.world
    .childrenOf(pack)
    .filter((i) => i.graphic === gold && !i.hue)
    .reduce((n, i) => n + (i.amount ?? 1), 0);

// The market goods a resident uses: bowyers boards, archers exceptional bows, other fighters
// potions, Tinkering trainees iron.
function wantedBy(template: CharacterTemplate): Good[] {
  const profession = professionOf(template.id)?.[0] ?? '';
  const wants: Good[] = [];
  if (profession === 'bowyer') wants.push('boards');
  if (/archer/.test(profession)) wants.push('exceptional bows');
  if (['swordsman', 'fencer', 'macer', 'tank-mage', 'pure-mage', 'archer'].includes(profession))
    wants.push('heal potions', 'cure potions');
  if ('Tinkering' in template.behavior.trainingGoals) wants.push('iron ingots');
  return wants;
}

// What this resident has seen itself (danger.ts keeps it by 16-tile area for twenty minutes, and
// calls it heard), around here or near a town the question names. Never a guess.
function safetyAnswer(session: PlayerSession, here: { x: number; y: number }, text: string) {
  const town = Object.keys(moongates).find((name) => new RegExp(`\\b${name}\\b`, 'i').test(text));
  const bank = town ? serviceLocations(town, 'banker')[0] : undefined;
  const around = bank ?? here;
  const seen = lasting('danger', session.world.serial ?? 0);
  const near: { x: number; y: number }[] = [];
  for (let dx = -5; dx <= 5; dx++)
    for (let dy = -5; dy <= 5; dy++) {
      const cx = (around.x >> 4) + dx;
      const cy = (around.y >> 4) + dy;
      if (seen.active(`${cx},${cy}`)) near.push({ x: cx * 16 + 8, y: cy * 16 + 8 });
    }
  const where = town ? `near ${town}` : 'hereabouts';
  if (!near.length) return `Quiet enough ${where}, as far as I have seen. Keep thine eyes open all the same.`;
  const closest = near.sort((a, b) => distance(around, a) - distance(around, b))[0] ?? around;
  return `I saw trouble ${where} not long ago, ${town ? 'around' : ''} ${directions(here, closest)}. Mind thyself.`.replace(
    '  ',
    ' '
  );
}
