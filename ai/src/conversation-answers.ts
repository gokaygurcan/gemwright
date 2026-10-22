import { cemeteries } from './cemeteries';
import type { CharacterTemplate } from './config';
import { activityLine } from './conversation';
import type { DecisionCoordinator } from './decisions';
import { type Intent, intents } from './dialogue';
import { type ServiceType, serviceLocations } from './locations';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Checkpoint } from './store';

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
      if (/gate/.test(asked)) return 'The moongates are marked on any map; I would not guess the nearest from here.';
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
