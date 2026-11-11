import { Notoriety } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';

import { debugEnabled } from '../debug';
import type { Step } from './options';

// Staff commands spoken to a resident (GEMWRIGHT::STOP, CONTINUE or RESUME, STATUS, WHY), heeded only
// from someone the shard makes invulnerable (staff; players cannot be). Not conversation: never
// answered as one. STOP holds it until CONTINUE, or until whoever stopped it leaves its view.
const command = /^\s*GEMWRIGHT::(STOP|CONTINUE|RESUME|STATUS|WHY)\s*$/i;

export class Narrator {
  private heard: number;
  private held?: number;
  private told?: string;
  // What it is doing and why, for STATUS and WHY.
  doing = 'waking up';
  why = 'nothing has gone wrong lately';

  constructor(private readonly session: PlayerSession) {
    this.heard = session.world.journal.length;
  }

  // Staff orders heard since last looked; true while it is held.
  listen() {
    const world = this.session.world;
    for (const entry of world.journal.slice(this.heard)) {
      const order = command.exec(entry.text ?? '')?.[1]?.toUpperCase();
      if (!order || world.entities.get(entry.serial)?.notoriety !== Notoriety.invulnerable) continue;
      if (order === 'STOP') this.held = entry.serial;
      else if (order === 'CONTINUE' || order === 'RESUME') this.held = undefined;
      else if (order === 'STATUS') this.session.say(`${this.doing}${this.held ? ' (stopped)' : ''}`.slice(0, 200));
      else this.session.say(this.why.slice(0, 200));
    }
    this.heard = world.journal.length;
    if (this.held !== undefined && !world.entities.has(this.held)) this.held = undefined;
    return this.held !== undefined;
  }

  // Each time it turns to something else, said over its head when the shard's debugging is on.
  tell(doing: string) {
    this.doing = doing;
    if (doing === this.told) return;
    this.told = doing;
    if (debugEnabled() && this.session.phase === 'ready') this.session.emote(doing.slice(0, 120));
  }
}

// What a plan is, in words: where it goes and what it does there.
export function describe(key: string, steps: readonly Step[]): string {
  const walk = steps.find((s) => s.verb === 'walk');
  const at = walk && walk.verb === 'walk' ? ` at ${walk.x},${walk.y}` : '';
  const going = /^go (\d+),(\d+): (.+)$/.exec(key);
  if (going) return `traveling to ${going[1]},${going[2]}: ${describe(going[3] ?? '', [])}`;
  if (key.startsWith('attack ')) return `fighting ${key.slice(7).split('/')[0]}`;
  if (key.startsWith('buy ')) return `shopping for ${key.slice(4)}${at}`;
  if (key.startsWith('sell ')) return `selling to ${key.slice(5).split('/')[0]}`;
  if (key === 'deposit') return `banking${at}`;
  if (key.startsWith('withdraw ')) return `taking ${key.slice(9).split('/')[0]} from the bank${at}`;
  const used = /^double-click my (\S+?)(?:\/\S*)? > target (.+)$/.exec(key);
  if (used) return `using ${used[1]} on ${used[2]}${at}`;
  return key;
}
