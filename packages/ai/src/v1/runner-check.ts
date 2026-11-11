import type { PlayerSession } from '@gemwright/network/session';

import { interruptForDanger } from './danger-response';
import { checkAction } from './execution-session';
import { checkLoop } from './loop-watch';

export function runnerCheck(options: {
  session: PlayerSession;
  label: string;
  deadline: number;
  stopping?: () => boolean;
  sighted?: boolean;
  dead?: () => boolean;
  reviving?: () => boolean;
}) {
  const { session } = options;
  return () => {
    checkAction(session);
    if (options.stopping?.() || Date.now() >= options.deadline)
      throw new Error(`${options.label} run duration reached`);
    if (session.phase !== 'ready') throw new Error(`${options.label} disconnected; reconcile before continuing`);
    if (options.dead?.() && !options.reviving?.()) throw new Error(`${options.label} is dead; resurrection is pending`);
    if (!options.reviving?.()) interruptForDanger(session, options.sighted ?? true);
    checkLoop(session);
  };
}
