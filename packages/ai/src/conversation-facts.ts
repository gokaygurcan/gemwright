import { skillLabel } from '@gemwright/common/skills';

import type { CharacterTemplate } from './config';
import { needsLine, residentNeeds } from './needs';
import { voiceStyle } from './personal-voice';
import type { PlayerSession } from './protocol/session';
import type { FactSheet } from './respond';
import type { Checkpoint } from './store';
import { professionOf } from './world';

// What a resident can truthfully say about itself in conversation: what it is doing, where it is
// going, what it lacks, and the fact sheet Haiku answers from (respond.ts).
// What a resident says it is doing, from its persisted goal phase.
export function activityLine(checkpoint: Checkpoint): string {
  const phase = checkpoint.goal?.phase ?? '';
  const ground = checkpoint.hunting?.ground ?? 'Britain';
  if (/fight|engag|pet-combat/.test(phase)) return 'I am too busy fighting to talk!';
  if (/patrol|choosing-opponent|hunting|graveyard|changing-ground/.test(phase))
    return `I hunt the undead at the ${ground} cemetery.`;
  if (/thief/.test(phase)) return 'Minding mine own business.';
  // On a side trade, from what it remembers paid (side-trade.ts).
  if (phase === 'side-trade') return sideTradeLine(checkpoint);
  if (/mining|mine-travel/.test(phase)) return 'I work the mines, seeking good ore.';
  if (/smelt|forge/.test(phase)) return 'I am smelting ore at the forge.';
  if (/smithing/.test(phase)) return 'I am smithing a few shields to sell.';
  if (/tam|companion/.test(phase)) return 'I seek animals to tame.';
  if (/fish/.test(phase)) return 'Fishing, and mostly waiting for a bite.';
  if (/bank/.test(phase)) return 'I am off to the bank.';
  if (/sell|restock|resupply|purchase|armor|training/.test(phase)) return 'Doing a bit of trading in town.';
  if (/rest|recover|heal/.test(phase)) return 'Catching my breath before I head out again.';
  if (/travel|moongate|mount/.test(phase)) return 'I am on the road.';
  return 'Just going about my business.';
}

// Where it is going, from its current phase's own words ("Heading to the orc spawn near
// 634,1462" becomes "I am heading to the orc spawn."), else what it is doing.
export function planLine(checkpoint: Checkpoint): string {
  const commitment = checkpoint.personal?.commitment;
  if (commitment && ['active', 'paused'].includes(commitment.state))
    return `I am ${commitment.kind === 'escort' ? 'showing' : 'keeping company with'} ${commitment.name}.`;
  const personal = checkpoint.personal?.goals.find((goal) => goal.state === 'active');
  if (personal) return `I am working to ${personal.description.toLowerCase()}.`;
  const note = (checkpoint.goal?.note ?? '').replace(/\s+near -?\d+,\s*-?\d+/g, '').replace(/[.;:]\s*$/, '');
  const first = note.split(' ')[0] ?? '';
  if (/ing$/i.test(first)) return `I am ${note.charAt(0).toLowerCase()}${note.slice(1)}.`;
  return activityLine(checkpoint);
}

export function factSheet(
  session: PlayerSession,
  checkpoint: Checkpoint,
  template: CharacterTemplate,
  city: string
): FactSheet {
  const me = session.world.entities.get(session.world.serial ?? -1)?.name ?? 'a resident';
  const best = [...session.world.skills]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 3)
    .filter(([, skill]) => skill.value > 0)
    .map(([id, skill]) => `${skillLabel(id)} ${skill.value.toFixed(1)}`);
  return {
    me,
    profession: professionOf(template.id)?.[0] ?? template.label,
    home: city,
    doing: activityLine(checkpoint),
    goingTo: planLine(checkpoint),
    needs: residentNeeds(session, checkpoint, template).map((need) => `${need.what}: ${need.why}`),
    carriedGold: session.world.status?.gold ?? 0,
    bestSkills: best,
    voice: voiceStyle(session),
    goals: checkpoint.personal?.goals.filter((goal) => goal.state === 'active').map((goal) => goal.description),
    sharedExperiences: checkpoint.personal?.episodes
      .slice(-6)
      .filter((episode) => episode.result !== 'interrupted')
      .map((episode) => `${episode.name}: ${episode.detail}`)
  };
}

export const needsReply = (session: PlayerSession, checkpoint: Checkpoint, template: CharacterTemplate) =>
  needsLine(residentNeeds(session, checkpoint, template));

function sideTradeLine(checkpoint: Checkpoint): string {
  const note = checkpoint.goal?.note ?? '';
  const what = /wood/i.test(note) ? 'chopping wood' : /ore/i.test(note) ? 'digging ore' : 'fishing';
  const paid = Object.entries(checkpoint.paid ?? {})
    .map(([kind, p]) => [kind, p.gold / Math.max(1, p.minutes)] as const)
    .sort((a, b) => b[1] - a[1])[0];
  return paid && paid[1] > 0
    ? `${what.charAt(0).toUpperCase()}${what.slice(1)} on the side; ${paid[0] === 'fish' ? 'fishing' : paid[0] === 'wood' ? 'wood' : 'ore'} has paid me best lately.`
    : `${what.charAt(0).toUpperCase()}${what.slice(1)} on the side, since my own work pays little just now.`;
}
