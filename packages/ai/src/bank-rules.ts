import { Bank } from '@gemwright/network/replies';

// The balance a banker reported, from its cliloc and arguments.
export function reportedBankGold(cliloc: number, argumentsText: string): number | undefined {
  const fields = argumentsText.split('\t');
  if (cliloc !== Bank.balance && cliloc !== Bank.accountBalance) return;
  const amounts = fields.map((field) => (/^\d[\d,]*$/.test(field) ? Number(field.replaceAll(',', '')) : NaN));
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) return;
  if (cliloc === Bank.balance && amounts.length === 1) return amounts[0];
  if (cliloc === Bank.accountBalance && amounts.length === 2)
    return Math.min(Number.MAX_SAFE_INTEGER, (amounts[0] ?? 0) * 1_000_000_000 + (amounts[1] ?? 0));
}

// What it keeps back from spending on training: a reserve, a cap an hour, and a share of its funds.
export const TRAINING = { reserve: 500, perHour: 300, share: 0.1 };

// ServUO Banker.HandlesOnSpeech answers bank/balance/withdraw within 12 tiles, unlike other vendors,
// so a player speaks from the bank floor instead of walking up to the counter. One tile of margin
// absorbs movement between our observation and the server's range check.
export const BANKER_SPEECH_RANGE = 11;
