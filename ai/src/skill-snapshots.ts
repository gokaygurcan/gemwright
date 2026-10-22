import type { PlayerSession } from './protocol/session';
import { skillNames } from './skills';
import type { ResidentStore, SkillReading } from './store';

// Each resident's skills as the server reports them, written to the resident database at most once
// an hour: checked a minute after login (once the skill list has arrived) and every ten minutes
// after that, saving only when the stored snapshot is an hour old. The `skills` report reads them.
const SAVE_EVERY_MS = 60 * 60_000;
const CHECK_EVERY_MS = 10 * 60_000;

export function recordSkills(store: ResidentStore, residentId: string, session: PlayerSession) {
  const check = () => {
    if (session.phase === 'offline' || session.phase === 'failed') {
      clearTimeout(first);
      clearInterval(timer);
      return;
    }
    if (session.phase !== 'ready' || !session.world.skills.size) return;
    if (Date.now() - (store.skillSnapshot(residentId)?.recordedAt ?? 0) < SAVE_EVERY_MS) return;
    const skills: Record<string, SkillReading> = {};
    for (const [id, skill] of session.world.skills) skills[skillNames[id] ?? `skill-${id}`] = { ...skill };
    store.saveSkillSnapshot(residentId, skills);
  };
  const first = setTimeout(check, 60_000);
  const timer = setInterval(check, CHECK_EVERY_MS);
}
