import { gems, gold } from '@gemwright/common/items';

import { tally } from './activity';
import { serviceLocations } from './locations';
import { approachMobile } from './mobile-approach';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import type { Checkpoint } from './store';

export function reportedBankGold(cliloc: number, argumentsText: string): number | undefined {
  const fields = argumentsText.split('\t');
  if (cliloc !== 1042759 && cliloc !== 1155855) return;
  const amounts = fields.map((field) => (/^\d[\d,]*$/.test(field) ? Number(field.replaceAll(',', '')) : NaN));
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) return;
  if (cliloc === 1042759 && amounts.length === 1) return amounts[0];
  if (cliloc === 1155855 && amounts.length === 2)
    return Math.min(Number.MAX_SAFE_INTEGER, (amounts[0] ?? 0) * 1_000_000_000 + (amounts[1] ?? 0));
}

// The verified ServUO classic profile charges vendor purchases to carried gold first, then the
// bank balance (BaseVendor.OnBuyItems). Spending power is therefore carried plus banked gold.
export const VENDORS_DRAW_FROM_BANK = true;
const FUNDS_TTL = 15 * 60_000;

export const carriedGold = (session: MountContext['session'], backpack: number) =>
  [...session.world.entities.values()]
    .filter((item) => item.parent === backpack && item.graphic === gold)
    .reduce((sum, item) => sum + (item.amount ?? 1), 0);

export const knownBankGold = (checkpoint: Checkpoint) =>
  VENDORS_DRAW_FROM_BANK && checkpoint.funds && Date.now() - checkpoint.funds.at < FUNDS_TTL
    ? checkpoint.funds.bank
    : 0;

export const fundsStale = (checkpoint: Checkpoint) =>
  !checkpoint.funds || Date.now() - checkpoint.funds.at >= FUNDS_TTL;

export const spendableGold = (session: MountContext['session'], backpack: number, checkpoint: Checkpoint) =>
  carriedGold(session, backpack) + knownBankGold(checkpoint);

// Runs a confirmed vendor purchase and debits the known bank balance by whatever the
// vendor charged beyond the observed carried-gold decrease.
// Training purchases (tools, reagents, spellbooks) are optional: they keep a 500-gold reserve and
// spend at most 300 gold per hour. A crafter buying materials to sell (`business`) is earning, not
// just training: it keeps 100 back and may spend 1,000 an hour, so a poor crafter can start out.
// With an unknown bank balance only carried gold counts.
export const TRAINING = { reserve: 500, perHour: 300 };
export const BUSINESS = { reserve: 100, perHour: 1000 };
// The tool a resident's own work needs (an instrument, a pole, a blade, scissors) is bought with
// whatever it has: without it there is no work and no income at all.
export const TOOLS = { reserve: 0, perHour: 500 };
const trainingSpend = new WeakMap<Checkpoint, { since: number; total: number }>();
export function canSpendOnTraining(
  session: MountContext['session'],
  backpack: number,
  checkpoint: Checkpoint,
  cost: number,
  limits = TRAINING
): boolean {
  const window = trainingSpend.get(checkpoint);
  const spent = window && Date.now() - window.since < 3_600_000 ? window.total : 0;
  const funds = fundsStale(checkpoint) ? carriedGold(session, backpack) : spendableGold(session, backpack, checkpoint);
  return spent + cost <= limits.perHour && funds - cost >= limits.reserve;
}
export function recordTrainingSpend(checkpoint: Checkpoint, cost: number) {
  const window = trainingSpend.get(checkpoint);
  if (window && Date.now() - window.since < 3_600_000) window.total += cost;
  else trainingSpend.set(checkpoint, { since: Date.now(), total: cost });
}

export async function chargedPurchase(
  ctx: Pick<MountContext, 'session' | 'checkpoint' | 'backpack'>,
  cost: number,
  purchase: () => Promise<void>
) {
  const before = carriedGold(ctx.session, ctx.backpack());
  await purchase();
  tally(ctx.session, 'goldToShops', cost);
  const fromBank = Math.max(0, cost - Math.max(0, before - carriedGold(ctx.session, ctx.backpack())));
  const funds = ctx.checkpoint.funds;
  if (fromBank && funds) ctx.checkpoint.funds = { bank: Math.max(0, funds.bank - fromBank), at: funds.at };
}

type BankerContext = Pick<MountContext, 'session' | 'serial' | 'position' | 'terrain' | 'navigate' | 'check'>;

// ServUO Banker.HandlesOnSpeech answers bank/balance/withdraw within 12 tiles, unlike other vendors,
// so a player speaks from the bank floor instead of walking up to the counter. One tile of margin
// absorbs movement between our observation and the server's range check.
export const BANKER_SPEECH_RANGE = 11;
async function withinBankerRange(ctx: BankerContext, banker: number) {
  const mobile = ctx.session.world.entities.get(banker);
  if (mobile?.position && distance(ctx.position(), mobile.position) <= BANKER_SPEECH_RANGE) return;
  // Speech carries across the bank floor: any reachable tile in range will do, so a crowd around the
  // counter (every adjacent tile taken) never blocks banking.
  if (mobile?.position) {
    try {
      await ctx.navigate(mobile.position, BANKER_SPEECH_RANGE - 2);
      if (distance(ctx.position(), mobile.position) <= BANKER_SPEECH_RANGE) return;
    } catch {
      ctx.check();
    }
  }
  await approachMobile(ctx, banker);
}

// Opens the personal bank box with the "bank" keyword and waits for its freshly sent contents.
export async function openBankBox(ctx: BankerContext, banker: number): Promise<number> {
  const { session } = ctx;
  await withinBankerRange(ctx, banker);
  const opened = session.world.received.get(0x3c) ?? 0;
  const displayed = session.world.received.get(0x24) ?? 0;
  session.say('bank');
  const box = () =>
    [...session.world.entities.values()].find((item) => item.parent === ctx.serial && item.layer === Layer.Bank);
  await session.waitFor(
    () =>
      !!box() &&
      ((session.world.received.get(0x3c) ?? 0) > opened || (session.world.received.get(0x24) ?? 0) > displayed),
    'bank box opened by speech',
    4000
  );
  const serial = box()?.serial;
  if (serial === undefined) throw new Error('Bank box disappeared');
  return serial;
}

// A banker is recognized by the enabled open-bank context entry, requested without walking over.
export async function offersBank(session: MountContext['session'], mobile: number): Promise<boolean> {
  if (session.world.entities.get(mobile)?.notoriety !== 7) return false;
  try {
    return (await session.context(mobile)).some((entry) => entry.cliloc === 3006105 && !(entry.flags & 1));
  } catch (error) {
    if (session.phase !== 'ready') throw error;
    return false;
  }
}

export async function queryBankBalance(
  ctx: Pick<MountContext, 'session' | 'serial' | 'position' | 'terrain' | 'navigate' | 'check' | 'checkpoint'>,
  banker: number
): Promise<number> {
  const { session } = ctx;
  const before = new Set(session.world.journal);
  await withinBankerRange(ctx, banker);
  session.say('balance');
  const reply = () =>
    session.world.journal.find(
      // Any banker in range may answer the keyword, not only the one approached.
      (entry) => !before.has(entry) && [1042759, 1155855, 500389].includes(entry.cliloc ?? 0)
    );
  await session.waitFor(() => !!reply(), 'banker balance reply', 3000);
  const bank = reportedBankGold(reply()?.cliloc ?? 0, reply()?.arguments ?? '') ?? 0;
  ctx.checkpoint.funds = { bank, at: Date.now() };
  return bank;
}

export async function withdrawAccountGold(
  ctx: Pick<
    MountContext,
    'session' | 'serial' | 'position' | 'terrain' | 'navigate' | 'check' | 'phase' | 'backpack' | 'checkpoint'
  >,
  banker: number,
  needed: number
): Promise<void> {
  const { session } = ctx;
  const available = await queryBankBalance(ctx, banker);
  const amount = Math.min(needed, available);
  if (amount <= 0) return;
  const carried = carriedGold(session, ctx.backpack());
  ctx.phase('withdrawing-gold', `Withdrawing ${amount} of this character's banked gold`);
  await withinBankerRange(ctx, banker);
  session.say(`withdraw ${amount}`);
  await session.waitFor(
    () => carriedGold(session, ctx.backpack()) >= carried + amount,
    'withdrawn gold observed in the backpack',
    4000
  );
  ctx.checkpoint.funds = { bank: available - amount, at: Date.now() };
}

// Carried gold and gems are lost with an unrecovered corpse: once the purse passes `limit`, or any
// gem is carried, gems and the gold over `keep` go into the bank box at the nearest bank of `city`.
// True when it deposited.
const surplusRetry = new WeakMap<object, number>();

// One of the town's banks, the nearer ones more often, and a different spot on its floor each time:
// people do not all queue at one tile.
export function bankSpot(city: string, from: { x: number; y: number }) {
  const landmark = [...serviceLocations(city, 'banker')].sort(
    (a, b) => distance(from, a) + Math.random() * 40 - (distance(from, b) + Math.random() * 40)
  )[0];
  if (!landmark) return undefined;
  const jitter = () => Math.round((Math.random() - 0.5) * 6);
  return { x: landmark.x + jitter(), y: landmark.y + jitter() };
}
export async function bankSurplus(
  ctx: BankerContext & { checkpoint: Checkpoint; backpack: () => number; phase: MountContext['phase'] },
  city: string,
  limit = 500,
  keep = 100
): Promise<boolean> {
  const { session } = ctx;
  const jewels = () => session.world.childrenOf(ctx.backpack()).filter((item) => gems.has(item.graphic));
  if (carriedGold(session, ctx.backpack()) < limit && !jewels().length) return false;
  // A trip that found no banker is not repeated every turn.
  if ((surplusRetry.get(session) ?? 0) > Date.now()) return false;
  surplusRetry.set(session, Date.now() + 30 * 60_000);
  const bank = bankSpot(city, ctx.position());
  if (!bank) return false;
  ctx.phase('banking', 'Taking surplus gold and gems to the bank');
  await ctx.navigate(bank, 4).catch(() => {});
  for (const mobile of [...session.world.entities.values()]) {
    if (mobile.kind !== 'mobile' || !mobile.position || distance(ctx.position(), mobile.position) > BANKER_SPEECH_RANGE)
      continue;
    if (!(await offersBank(session, mobile.serial))) continue;
    const box = await openBankBox(ctx, mobile.serial).catch(() => undefined);
    if (box === undefined) continue;
    for (const gem of jewels()) await session.moveItem(gem.serial, box).catch(() => {});
    let pocket = keep;
    for (const coins of session.world.childrenOf(ctx.backpack()).filter((item) => item.graphic === gold)) {
      const kept = Math.min(pocket, coins.amount ?? 1);
      pocket -= kept;
      if ((coins.amount ?? 1) - kept > 0) await session.moveItem(coins.serial, box, (coins.amount ?? 1) - kept);
    }
    await queryBankBalance(ctx, mobile.serial).catch(() => 0);
    surplusRetry.delete(session);
    return true;
  }
  ctx.phase('banking-failed', `No banker answered near ${bank.x},${bank.y}; trying again later`);
  return false;
}

// Asks a banker in `city` for the current balance when the recorded one is stale, so purchases
// charged to the bank (tools, supplies) see the real spending power, not just carried coins.
export async function refreshFunds(ctx: BankerContext & { checkpoint: Checkpoint }, city: string) {
  if (!fundsStale(ctx.checkpoint)) return;
  const bank = bankSpot(city, ctx.position());
  if (!bank) return;
  await ctx.navigate(bank, 4).catch(() => {});
  for (const mobile of ctx.session.world.entities.values()) {
    if (mobile.kind !== 'mobile' || !mobile.position || distance(ctx.position(), mobile.position) > BANKER_SPEECH_RANGE)
      continue;
    if (!(await offersBank(ctx.session, mobile.serial))) continue;
    await queryBankBalance(ctx, mobile.serial).catch(() => 0);
    return;
  }
}
