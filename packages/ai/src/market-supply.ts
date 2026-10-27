import { lasting } from './lasting';

// What the market has heard lately, shared by every resident and kept across restarts
// (lasting.ts): who is selling and who is buying each good this hour, and who has sold it in a
// completed deal (three days). Prices follow it: more buyers than sellers lift asks and bids,
// more sellers lower them (market.ts stance); buyers turn to known sellers first.
const heardLines = lasting('market-heard');
const sellers = lasting('market-sellers');
const HOUR = 3_600_000;

export function noteLine(good: string, side: 'selling' | 'buying', speaker: number) {
  heardLines.set(`${good}|${side}|${speaker}`, Date.now() + HOUR);
}

function speakers(good: string, side: 'selling' | 'buying') {
  let n = 0;
  for (const [key, until] of heardLines.entries()) if (until > Date.now() && key.startsWith(`${good}|${side}|`)) n++;
  return n;
}

// How far a price leans from the stance: -0.2 (glut) to +0.2 (scarce).
export function supplyShift(good: string) {
  const buying = speakers(good, 'buying');
  const selling = speakers(good, 'selling');
  return Math.max(-0.2, Math.min(0.2, ((buying - selling) / (buying + selling + 2)) * 0.4));
}

export const noteSeller = (good: string, seller: number) =>
  sellers.set(`${good}|${seller}`, Date.now() + 3 * 24 * HOUR);
export const knownSeller = (good: string, seller: number) => sellers.active(`${good}|${seller}`);
