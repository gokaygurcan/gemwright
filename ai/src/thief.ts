import { type ProfessionOptions, runProfession } from './profession';
import { createThiefActions } from './thief-actions';

// A thief lives in its home town without a mount (world.json `mount: false`), practises Hiding,
// Stealth, Detect Hidden and its supporting skills, and works the cemetery nearest home: it hides,
// sneaks in walking to a lone zombie or skeleton, steals from its pack, breaks away and banks what
// it took. Between trips it cases packs it is allowed to peek into (pack animals) and practises
// quiet skills. Creature backpacks refuse players on the pinned shard, so snooping cannot be used
// on the marks themselves.
export const runThief = (options: ProfessionOptions) => {
  const actions = createThiefActions({ peers: options.peers });
  return runProfession(
    'thief',
    options,
    async (ctx) => {
      if (await actions.attempt(ctx)) {
        ctx.progress.actions = (ctx.progress.actions ?? 0) + 1;
        return;
      }
      ctx.phase('thief-practice', 'Practising quiet skills around town');
      await ctx.practise(3 + Math.random() * 3);
    },
    {
      // In a dungeon: lone weak creatures of any kind are the marks; the trip home banks the takings.
      ready: () => true,
      work: (ctx, radius) => actions.dungeonStep(ctx, radius),
      afterRun: () => actions.afterDungeon()
    }
  );
};
