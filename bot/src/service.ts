import { getAddress, isAddress, isHash, parseUnits, type Address, type Hex } from "viem";
import type { Store, TipRow } from "./db.ts";
import type { MiniAppUser } from "./telegram-auth.ts";
import type { Operator } from "./operator.ts";
import { PaymentError, type Chain, type PayPlan } from "./chain.ts";

/** Errors safe to show the user; anything else is logged and reported generically. */
export class UserError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503 = 400) {
    super(message);
  }
}

export type Role = "sender" | "recipient" | "viewer";

export function roleOf(tip: TipRow, user: MiniAppUser): Role {
  if (tip.sender_tg_id === user.id) return "sender";
  if (tip.recipient_tg_id === user.id) return "recipient";
  if (
    tip.recipient_tg_id === null &&
    tip.recipient_username &&
    user.username &&
    tip.recipient_username.toLowerCase() === user.username.toLowerCase()
  ) {
    return "recipient";
  }
  return "viewer";
}

/** What the Mini App may see about a tip. Never includes other people's Telegram ids. */
export function publicTip(tip: TipRow, user: MiniAppUser) {
  return {
    id: tip.id,
    role: roleOf(tip, user),
    status: tip.status,
    senderName: tip.sender_name,
    recipientName: tip.recipient_username ? `@${tip.recipient_username}` : tip.recipient_name,
    ticker: tip.ticker,
    symbol: tip.symbol,
    companyName: tip.company_name,
    tokenAddress: tip.token_address,
    amountUsd: tip.amount_usd,
    sharePrice: tip.share_price,
    tokenAmount: tip.token_amount,
    payTx: tip.pay_tx,
    claimTx: tip.claim_tx,
    claimWallet: tip.claim_wallet,
    createdAt: tip.created_at,
  };
}

const MIN_RECEIVED_RATIO = 0.9; // tolerate price moves between card and payment

export class TipService {
  constructor(
    private store: Store,
    private chain: Chain,
    private operator: Operator,
    private onChange: (tipId: string) => Promise<void>,
  ) {}

  private load(id: string): TipRow {
    const tip = this.store.tip(id);
    if (!tip) throw new UserError("Tip not found.", 404);
    return tip;
  }

  private wallet(raw: unknown): Address {
    if (typeof raw !== "string" || !isAddress(raw)) throw new UserError("That isn't a valid wallet address.");
    return getAddress(raw);
  }

  async planPayment(id: string, user: MiniAppUser, rawWallet: unknown): Promise<PayPlan> {
    const tip = this.load(id);
    if (roleOf(tip, user) !== "sender") throw new UserError("Only the sender can pay for this tip.", 403);
    if (tip.status !== "awaiting_payment") throw new UserError("This tip isn't waiting for payment any more.", 409);
    try {
      return await this.chain.planPayment({
        tipId: tip.id,
        wallet: this.wallet(rawWallet),
        token: tip.token_address as Address,
        tokenDecimals: 18,
        amountUsd: tip.amount_usd,
      });
    } catch (e) {
      if (e instanceof PaymentError) throw new UserError(e.message);
      throw e;
    }
  }

  /** Called by the Mini App once the sender's tipWithSwap transaction is sent. */
  async confirmPayment(id: string, user: MiniAppUser, rawTx: unknown): Promise<TipRow> {
    const tip = this.load(id);
    if (roleOf(tip, user) !== "sender") throw new UserError("Only the sender can confirm this payment.", 403);
    if (tip.status !== "awaiting_payment") {
      if (tip.pay_tx && tip.pay_tx === rawTx) return tip; // already confirmed: safe retry
      throw new UserError("This tip isn't waiting for payment any more.", 409);
    }
    if (typeof rawTx !== "string" || !isHash(rawTx)) throw new UserError("That isn't a transaction hash.");

    const expectedTokens = tip.amount_usd / tip.token_price;
    const minTokens = parseUnits((expectedTokens * MIN_RECEIVED_RATIO).toFixed(18), 18);
    let paid;
    try {
      paid = await this.chain.verifyPayment(rawTx as Hex, {
        tipId: tip.id,
        token: tip.token_address as Address,
        minTokens,
      });
    } catch (e) {
      if (e instanceof PaymentError) throw new UserError(e.message);
      throw e;
    }

    // If the sweeper cancelled the card while the tx was in flight, the money is still escrowed,
    // so accept the payment from "cancelled" too.
    const ok =
      this.store.transition(tip.id, "awaiting_payment", "escrowed", {
        onchain_tip_id: paid.onchainTipId,
        token_amount: paid.tokenAmount.toString(),
        pay_tx: rawTx,
      }) ||
      this.store.transition(tip.id, "cancelled", "escrowed", {
        onchain_tip_id: paid.onchainTipId,
        token_amount: paid.tokenAmount.toString(),
        pay_tx: rawTx,
      });
    if (!ok) throw new UserError("This tip changed while confirming. Refresh and try again.", 409);
    await this.onChange(tip.id).catch((e) => console.error("onChange", e));
    return this.load(tip.id);
  }

  /** Recipient claims to their (Privy) wallet. The operator wallet pays the gas. */
  async claim(id: string, user: MiniAppUser, rawWallet: unknown): Promise<TipRow> {
    const tip = this.load(id);
    if (roleOf(tip, user) !== "recipient") throw new UserError("This tip is for someone else.", 403);
    if (tip.status === "claiming" || tip.status === "claimed") return tip;
    if (tip.status !== "escrowed" || tip.onchain_tip_id === null) {
      throw new UserError("This tip can't be claimed yet.", 409);
    }
    const wallet = this.wallet(rawWallet);

    if (!this.store.transition(tip.id, "escrowed", "claiming", { claim_wallet: wallet, recipient_tg_id: user.id })) {
      return this.load(tip.id); // a parallel request is already claiming
    }

    let result;
    try {
      result = await this.operator.call(this.chain.escrow, this.chain.claimCalldata(tip.onchain_tip_id, wallet));
    } catch (e) {
      this.store.transition(tip.id, "claiming", "escrowed");
      console.error(`claim ${tip.id} failed`, e);
      throw new UserError("Couldn't send your claim right now. Please try again in a minute.", 409);
    }

    if (result.status === "broadcast") {
      this.store.transition(tip.id, "claiming", "claiming", { claim_tx: result.txHash });
      const receipt = await this.chain.client
        .waitForTransactionReceipt({ hash: result.txHash, timeout: 60_000 })
        .catch(() => null);
      if (receipt?.status === "success") {
        this.store.transition(tip.id, "claiming", "claimed");
        await this.onChange(tip.id).catch((e) => console.error("onChange", e));
      }
      // Reverted or slow: leave it in "claiming"; the watcher settles it from chain state.
    }
    return this.load(tip.id);
  }

  /**
   * Finishes claims from on-chain state: covers Agentic Wallet calls that waited for approval in
   * the Binance App, and receipts we timed out on. A claim stuck unsettled for 15 min goes back to
   * "escrowed" so the recipient can retry.
   */
  async settleClaims(): Promise<void> {
    for (const tip of this.store.byStatus("claiming")) {
      if (tip.onchain_tip_id === null) continue;
      const settled = await this.chain.isSettled(tip.onchain_tip_id);
      if (settled) {
        if (this.store.transition(tip.id, "claiming", "claimed")) {
          await this.onChange(tip.id).catch((e) => console.error("onChange", e));
        }
      } else if (Date.now() - tip.updated_at > 15 * 60_000) {
        this.store.transition(tip.id, "claiming", "escrowed", { claim_tx: null });
      }
    }
  }
}
