import type { PlayerSession } from './protocol/session';
import { residentContext } from './resident-context';

export function voiceStyle(session: PlayerSession) {
  const saved = residentContext(session)?.checkpoint.personal?.habits?.style;
  return saved ?? (['plain', 'friendly', 'reserved'] as const)[(session.world.serial ?? 0) % 3] ?? 'plain';
}

export function personalVoice(session: PlayerSession, line: string): string {
  if (voiceStyle(session) === 'reserved') return line;
  return line
    .replace(/fare thee well/gi, 'See you')
    .replace(/thank thee kindly/gi, 'Thank you')
    .replace(/\bthee\b/gi, 'you')
    .replace(/\bthy\b/gi, 'your')
    .replace(/\bthou\b/gi, 'you')
    .replace(/\bdost\b/gi, 'do')
    .replace(/\bart\b/gi, 'are')
    .replace(/\bhail\b/gi, voiceStyle(session) === 'friendly' ? 'Hey' : 'Hello');
}
