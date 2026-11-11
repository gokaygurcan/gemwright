import { bandage, boltOfCloth, cloth, scissors, uncutCloth } from '@gemwright/common/game/items';
import { soldAs } from '@gemwright/common/game/rules';

// What a resident can turn one thing into with a tool in hand, the way the shard does it: rules of
// the world, not plans. Whether any of them pays is for the resident to work out from the prices it
// knows (opportunity.ts). Scissors cut a whole stack at once (ServUO IScissorable: a bolt gives
// fifty cloth, an uncut piece one, a cloth one bandage).
export interface Transformation {
  from: number;
  tools: ReadonlySet<number>;
  // The tool to buy when none is carried (ServUO Scissors).
  tool: number;
  yields: number;
  per: number;
}

export const transformations: readonly Transformation[] = [
  { from: boltOfCloth, tools: scissors, tool: soldAs('Scissors'), yields: cloth, per: 50 },
  { from: uncutCloth, tools: scissors, tool: soldAs('Scissors'), yields: cloth, per: 1 },
  { from: cloth, tools: scissors, tool: soldAs('Scissors'), yields: bandage, per: 1 }
];
