import { skillId } from '@gemwright/common/skills';

import { knownBankGold } from './bank-gold';
import type { LifeContext } from './life';
import { residentNeeds } from './needs';
import { personalMemory } from './resident-memory';
import type { PersonalGoal } from './resident-memory-types';
import { professionOf, world } from './world';

export function updatePersonalGoals(ctx: Pick<LifeContext, 'session' | 'template' | 'checkpoint'>, now = Date.now()) {
  const { session, template, checkpoint } = ctx;
  const memory = personalMemory(checkpoint, now);
  const funds = (session.world.status?.gold ?? 0) + knownBankGold(checkpoint);
  const needs = residentNeeds(session, checkpoint, template);
  const active = memory.goals.find((goal) => goal.state === 'active');
  if (active) {
    if (active.kind === 'supplies')
      active.progress = needs.some((need) => need.what === active.description.replace(/^Obtain /, '')) ? 0 : 1;
    else if (active.kind === 'skill')
      active.progress = session.world.skills.get(skillId(active.description.replace(/^Improve /, '')))?.base ?? 0;
    else if (active.kind === 'supply-order') {
      active.progress = memory.orders.filter((order) => order.state === 'completed').length;
      if (
        active.progress < active.target &&
        !memory.orders.some((order) => ['accepted', 'ready'].includes(order.state) && order.until > now)
      )
        active.state = 'blocked';
    } else active.progress = Math.min(active.target, funds);
    if (active.progress >= active.target) {
      active.state = 'completed';
      checkpoint.memories.push({ at: new Date(now).toISOString(), text: `Reached my goal: ${active.description}` });
      checkpoint.memories = checkpoint.memories.slice(-50);
    }
  }
  if (memory.goals.some((goal) => goal.state === 'active')) return memory.goals.find((goal) => goal.state === 'active');
  const completed = new Set(memory.goals.filter((goal) => goal.state === 'completed').map((goal) => goal.description));
  const tool = needs.find((need) => need.kind === 'tool');
  const profession = professionOf(template.id)?.[0];
  let next: Omit<PersonalGoal, 'id' | 'startedAt' | 'state'> | undefined;
  if (tool) next = { kind: 'supplies', description: `Obtain ${tool.what}`, target: 1, progress: 0 };
  else if (memory.orders.some((order) => order.state === 'accepted' || order.state === 'ready'))
    next = {
      kind: 'supply-order',
      description: 'Complete my agreed supply order',
      target: memory.orders.filter((order) => order.state === 'completed').length + 1,
      progress: memory.orders.filter((order) => order.state === 'completed').length
    };
  else if (
    profession &&
    world.professions[profession]?.mount &&
    !checkpoint.mount &&
    funds < 1000 &&
    !completed.has('Save 1000 gold for a horse and supplies')
  )
    next = { kind: 'mount', description: 'Save 1000 gold for a horse and supplies', target: 1000, progress: funds };
  else {
    const skill = template.archetype?.primarySkills.find(
      (name) =>
        (session.world.skills.get(skillId(name))?.base ?? 0) <
        Math.min(100, template.behavior.trainingGoals[name] ?? 100)
    );
    if (skill)
      next = {
        kind: 'skill',
        description: `Improve ${skill}`,
        target: Math.min(100, template.behavior.trainingGoals[skill] ?? 100),
        progress: session.world.skills.get(skillId(skill))?.base ?? 0
      };
    else if (funds < 1500)
      next = {
        kind: 'equipment',
        description: 'Keep 1500 gold for better equipment and replacements',
        target: 1500,
        progress: funds
      };
  }
  if (next) memory.goals.push({ ...next, id: `goal:${now}`, startedAt: now, state: 'active' });
  personalMemory(checkpoint, now);
  return memory.goals.find((goal) => goal.state === 'active');
}

export function goalPhaseBias(ctx: Pick<LifeContext, 'checkpoint'>, phase: string): number {
  const goal = ctx.checkpoint.personal?.goals.find((entry) => entry.state === 'active');
  if (!goal) return 1;
  if (goal.kind === 'skill') return phase === 'practice' || phase === 'work' ? 1.7 : 0.8;
  return phase === 'work' || phase === 'errands' ? 1.8 : phase === 'visit' ? 0.5 : 0.8;
}
