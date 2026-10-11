export interface TipArgs {
  amountUsd: number;
  ticker: string;
  /** Username without the "@", if one was written in the command. */
  mention: string | null;
}

export type ParseResult = { ok: true; args: TipArgs } | { ok: false; error: string };

export const TIP_USAGE = "Usage: /tip @user 5 NVDA (or reply to someone's message with /tip 5 NVDA)";

const AMOUNT = /^\$?(\d+(?:\.\d{1,2})?)\$?$/;
const TICKER = /^\$?[A-Za-z][A-Za-z0-9.]{0,9}$/;
const MENTION = /^@([A-Za-z0-9_]{4,32})$/;

/**
 * Parses the text after "/tip". Accepts the three parts in any order:
 * "@alice 5 NVDA", "$5 nvda @alice", "5 NVDA" (when replying).
 */
export function parseTipArgs(text: string, limits: { min: number; max: number }): ParseResult {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, error: TIP_USAGE };

  let amount: number | null = null;
  let ticker: string | null = null;
  let mention: string | null = null;

  for (const part of parts) {
    const m = MENTION.exec(part);
    if (m) {
      if (mention) return { ok: false, error: "You can tip one person at a time." };
      mention = m[1];
      continue;
    }
    const a = AMOUNT.exec(part);
    if (a) {
      if (amount !== null) return { ok: false, error: TIP_USAGE };
      amount = Number(a[1]);
      continue;
    }
    if (TICKER.test(part)) {
      if (ticker) return { ok: false, error: TIP_USAGE };
      ticker = part.replace(/^\$/, "").toUpperCase();
      continue;
    }
    return { ok: false, error: `I didn't understand "${part}". ${TIP_USAGE}` };
  }

  if (amount === null || ticker === null) return { ok: false, error: TIP_USAGE };
  if (amount < limits.min) return { ok: false, error: `The minimum tip is $${limits.min}.` };
  if (amount > limits.max) return { ok: false, error: `The maximum tip is $${limits.max}.` };

  return { ok: true, args: { amountUsd: amount, ticker, mention } };
}
