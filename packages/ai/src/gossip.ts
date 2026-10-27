import { lasting } from './lasting';
import { townAt } from './locations';
import { residentsAround } from './spread';

// Things that really happened, retold: a death, a red player on the road. Each event remembers
// the residents near it when it happened (spread.ts); only they, and whoever later hears it from
// one of them, can tell it. A resident tells each story once, within three hours, and never one
// about itself.
interface Event {
  id: number;
  about: number;
  line: string;
  at: number;
  knownBy: Set<number>;
}
const STORY_MS = 3 * 3_600_000;
const events: Event[] = [];
let next = 1;

const placeName = (at: { x: number; y: number }) => {
  const town = townAt(at, '');
  return town ? `near ${town}` : `out by ${at.x},${at.y}`;
};

export function recordEvent(about: number, what: (place: string) => string, at: { x: number; y: number }) {
  const knownBy = new Set(residentsAround(at, 40));
  knownBy.add(about);
  events.push({ id: next++, about, line: what(placeName(at)), at: Date.now(), knownBy });
  while (events.length > 200 || (events[0] && Date.now() - events[0].at > STORY_MS)) events.shift();
}

// A story this resident can tell `listener`, or undefined; telling it passes it on.
export function gossipFor(me: number, listener: number): string | undefined {
  const told = lasting('told', me);
  const story = events.find(
    (e) =>
      e.knownBy.has(me) && e.about !== me && e.about !== listener && !told.active(e.id) && Date.now() - e.at < STORY_MS
  );
  if (!story) return undefined;
  told.set(story.id, Date.now() + STORY_MS);
  story.knownBy.add(listener);
  return story.line;
}
