import { skillNames } from '@gemwright/common/game/skills';
import type { PlayerSession } from '@gemwright/network/session';

import { beginLifeAction, entityDetails, lifeEvent, noteLifeTarget } from './life-events';
import { observeLife } from './life-observations';

const observed = new WeakSet<PlayerSession>();
const describe = (session: PlayerSession, method: string, args: unknown[]): Record<string, unknown> => {
  const number = (index: number) => Number(args[index]);
  const entity = (index: number) => entityDetails(session, number(index));
  switch (method) {
    case 'useSkill':
      return { skill: args[1] ? `spell:${number(0)}` : (skillNames[number(0)] ?? number(0)), spell: !!args[1] };
    case 'use':
    case 'attack':
    case 'equipItem':
    case 'dropAtFeet':
      return { subject: entity(0), layer: method === 'equipItem' ? args[1] : undefined };
    case 'moveItem':
    case 'giveToMobile':
      return { item: entity(0), destination: entity(1), amount: args[2] ?? null };
    case 'purchaseItem':
      return { vendor: entity(0), item: entity(1), amount: args[3], budget: args[4] };
    case 'purchaseAnimal':
      return { vendor: entity(0), animal: entity(1), budget: args[2] };
    case 'sell':
      return { vendor: entity(0), items: args[1] };
    case 'say':
      return { text: String(args[0]).slice(0, 1000) };
    case 'target':
      return { target: args[0] };
    case 'party':
      return { command: args[0], leader: args[1] };
    case 'replyGump':
      return { serial: args[0], gump: args[1], button: args[2], switches: args[3] };
    case 'selectContext':
      return { target: entity(0), entry: args[1] };
    default:
      return {};
  }
};
const methods = [
  'useSkill',
  'use',
  'attack',
  'moveItem',
  'giveToMobile',
  'purchaseItem',
  'purchaseAnimal',
  'sell',
  'equipItem',
  'dropAtFeet',
  'say',
  'target',
  'party',
  'replyGump',
  'selectContext'
] as const;

export function observeLifeActions(session: PlayerSession) {
  if (observed.has(session)) return;
  observed.add(session);
  observeLife(session);
  for (const method of methods) {
    const original = Reflect.get(session, method) as (...args: unknown[]) => unknown;
    if (typeof original !== 'function') continue;
    Reflect.set(session, method, (...args: unknown[]) => {
      if (['attack', 'use', 'purchaseItem', 'purchaseAnimal', 'sell', 'selectContext'].includes(method))
        noteLifeTarget(session, Number(args[0]));
      const action = beginLifeAction(session, method, describe(session, method, args));
      const beforeGold = session.world.status?.gold;
      const finish = () => ({
        carriedGoldBefore: beforeGold ?? null,
        carriedGoldAfter: session.world.status?.gold ?? null,
        subjectAfter: ['moveItem', 'giveToMobile', 'equipItem', 'dropAtFeet', 'use'].includes(method)
          ? entityDetails(session, Number(args[0]))
          : undefined
      });
      try {
        const result = action.run(() => Reflect.apply(original, session, args));
        if (result instanceof Promise)
          return result.then(
            (value) => {
              action.finish(method === 'purchaseAnimal' || method === 'giveToMobile' ? 'sent' : 'completed', finish());
              return value;
            },
            (error: unknown) => {
              action.finish('failed', {
                reason: error instanceof Error ? error.message.slice(0, 1000) : String(error)
              });
              throw error;
            }
          );
        action.finish('sent', finish());
        return result;
      } catch (error) {
        action.finish('failed', { reason: error instanceof Error ? error.message.slice(0, 1000) : String(error) });
        throw error;
      }
    });
  }
  const wait = session.waitFor.bind(session);
  session.waitFor = async (predicate, label, timeout, options) => {
    if (/movement acknowledgement|status|skill list|properties|context menu|ping|character list/i.test(label))
      return wait(predicate, label, timeout, options);
    const action = beginLifeAction(session, 'outcome_check', { condition: label });
    try {
      await action.run(() => wait(predicate, label, timeout, options));
      action.finish('observed');
    } catch (error) {
      action.finish('failed', { reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  const close = session.close.bind(session);
  let ended = false;
  session.close = () => {
    if (!ended) {
      ended = true;
      lifeEvent(session, 'session', 'completed', { reason: session.failureReason ?? 'closed', phase: session.phase });
    }
    close();
  };
}
