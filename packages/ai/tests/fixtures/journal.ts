// A hand-made world's journal as the client keeps one: what was heard all told, and what since a mark.
export const heard = <T extends { journal: unknown[] }>(world: T) =>
  Object.defineProperties(world, {
    heard: {
      get(this: T) {
        return this.journal.length;
      }
    },
    journalSince: {
      value(this: T, mark: number) {
        return this.journal.slice(mark);
      }
    }
  }) as T & { heard: number; journalSince: (mark: number) => T['journal'] };
