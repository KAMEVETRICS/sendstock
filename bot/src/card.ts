import type { TipRow } from "./db.ts";
import type { MarketStatus } from "./rwa.ts";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Fractional shares, with enough digits that small tips don't show as 0.00. */
export function shares(n: number): string {
  if (n >= 1) return n.toFixed(3);
  const digits = Math.min(8, Math.max(4, 2 - Math.floor(Math.log10(n))));
  return n.toFixed(digits);
}

const SESSION_LABEL: Record<string, string> = {
  premarket: "US pre-market",
  regular: "US market open",
  afterhours: "US after-hours",
  overnight: "US overnight session",
  closed: "US market closed",
};

function utcTime(d: Date): string {
  const day = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day} ${time} UTC`;
}

/** One line telling people the stock moves 24/7 on-chain even when Wall Street is shut. */
export function marketLine(m: MarketStatus | null): string {
  if (!m) return "";
  const label = (m.session && SESSION_LABEL[m.session]) ?? (m.open ? "US market open" : "US market closed");
  if (m.session === "regular") return `🟢 ${label}`;
  // nextOpen is the next *session* change (e.g. overnight → pre-market), so only show it when
  // trading is actually closed; otherwise it reads like the US open time when it isn't.
  const next = !m.open && m.nextOpen && m.nextOpen.getTime() > Date.now() ? ` · reopens ${utcTime(m.nextOpen)}` : "";
  return `🌙 ${label}${next}. Your tip is still a real stock, on-chain 24/7.`;
}

function who(tip: TipRow): string {
  return tip.recipient_username ? `@${escapeHtml(tip.recipient_username)}` : escapeHtml(tip.recipient_name);
}

function headline(tip: TipRow): string {
  const approxShares = tip.amount_usd / tip.share_price;
  return [
    `🎁 <b>${escapeHtml(tip.sender_name)}</b> is tipping ${who(tip)} <b>${usd(tip.amount_usd)} of ${escapeHtml(tip.company_name)}</b>`,
    `≈ ${shares(approxShares)} ${escapeHtml(tip.ticker)} shares at ${usd(tip.share_price)} (${escapeHtml(tip.symbol)} on BNB Chain)`,
  ].join("\n");
}

export function pendingCard(tip: TipRow, market: MarketStatus | null, payWindowMinutes: number): string {
  const lines = [headline(tip), ""];
  const line = marketLine(market);
  if (line) lines.push(line);
  lines.push(`<i>Waiting for ${escapeHtml(tip.sender_name)} to confirm (expires in ${payWindowMinutes} min).</i>`);
  return lines.join("\n");
}

export function escrowedCard(tip: TipRow, direct = false): string {
  const next = direct
    ? `✅ Paid. ${who(tip)} can claim it now.`
    : `✅ Sent. ${who(tip)}, tap <b>Claim</b> to get your shares. No seed phrase, no gas.`;
  return [headline(tip), "", next].join("\n");
}

/** What the recipient sees (or what the sender shares) for a tip sent in a DM. */
export function claimInvite(tip: TipRow, html = true): string {
  const b = (s: string) => (html ? `<b>${escapeHtml(s)}</b>` : s);
  return [
    `🎁 ${b(tip.sender_name)} sent you ${b(`${usd(tip.amount_usd)} of ${tip.company_name}`)} (≈ ${shares(tip.amount_usd / tip.share_price)} ${tip.ticker} shares) with SendStock.`,
    "",
    "Open the link, sign in with Telegram, and tap Claim. No seed phrase, no gas.",
  ].join("\n");
}

export function claimedCard(tip: TipRow): string {
  return [headline(tip), "", `🎉 Claimed by ${who(tip)}.`].join("\n");
}

export function cancelledCard(tip: TipRow, reason = "Tip cancelled."): string {
  return `<s>${escapeHtml(tip.sender_name)} → ${who(tip)}: ${usd(tip.amount_usd)} of ${escapeHtml(tip.ticker)}</s>\n${escapeHtml(reason)}`;
}
