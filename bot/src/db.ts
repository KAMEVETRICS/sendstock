import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export type TipStatus = "awaiting_payment" | "escrowed" | "claiming" | "claimed" | "refunded" | "cancelled";

export interface TipRow {
  id: string;
  chat_id: number;
  message_id: number | null;
  sender_tg_id: number;
  sender_name: string;
  recipient_tg_id: number | null;
  recipient_username: string | null;
  recipient_name: string;
  ticker: string;
  symbol: string;
  token_address: string;
  amount_usd: number;
  /** Underlying share price when the tip was created. */
  share_price: number;
  /** On-chain price of one token when the tip was created (= share price × multiplier). */
  token_price: number;
  company_name: string;
  status: TipStatus;
  onchain_tip_id: number | null;
  token_amount: string | null;
  pay_tx: string | null;
  claim_tx: string | null;
  claim_wallet: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewTip {
  chatId: number;
  senderTgId: number;
  senderName: string;
  recipientTgId: number | null;
  recipientUsername: string | null;
  recipientName: string;
  ticker: string;
  symbol: string;
  tokenAddress: string;
  amountUsd: number;
  sharePrice: number;
  tokenPrice: number;
  companyName: string;
}

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Unguessable public id; safe for Mini App start parameters ([A-Za-z0-9_-]). */
export function newTipId(length = 12): string {
  const bytes = randomBytes(length);
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        tg_id      INTEGER PRIMARY KEY,
        username   TEXT,
        name       TEXT NOT NULL,
        wallet     TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS users_username ON users (lower(username));
      CREATE TABLE IF NOT EXISTS tips (
        id                 TEXT PRIMARY KEY,
        chat_id            INTEGER NOT NULL,
        message_id         INTEGER,
        sender_tg_id       INTEGER NOT NULL,
        sender_name        TEXT NOT NULL,
        recipient_tg_id    INTEGER,
        recipient_username TEXT,
        recipient_name     TEXT NOT NULL,
        ticker             TEXT NOT NULL,
        symbol             TEXT NOT NULL,
        token_address      TEXT NOT NULL,
        amount_usd         REAL NOT NULL,
        share_price        REAL NOT NULL,
        token_price        REAL NOT NULL,
        company_name       TEXT NOT NULL,
        status             TEXT NOT NULL,
        onchain_tip_id     INTEGER UNIQUE,
        token_amount       TEXT,
        pay_tx             TEXT UNIQUE,
        claim_tx           TEXT,
        claim_wallet       TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tips_status ON tips (status, created_at);
    `);
  }

  // ------------------------------------------------------------------ users

  /** Remember who we've seen, so "@username" can be resolved to a Telegram id later. */
  seeUser(tgId: number, username: string | undefined, name: string): void {
    this.db
      .prepare(
        `INSERT INTO users (tg_id, username, name, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tg_id) DO UPDATE SET username = excluded.username, name = excluded.name,
           updated_at = excluded.updated_at`,
      )
      .run(tgId, username ?? null, name, Date.now());
  }

  userByUsername(username: string): { tg_id: number; name: string } | undefined {
    return this.db
      .prepare(`SELECT tg_id, name FROM users WHERE lower(username) = lower(?) ORDER BY updated_at DESC LIMIT 1`)
      .get(username) as { tg_id: number; name: string } | undefined;
  }

  // ------------------------------------------------------------------- tips

  createTip(t: NewTip): TipRow {
    const now = Date.now();
    const id = newTipId();
    this.db
      .prepare(
        `INSERT INTO tips (id, chat_id, sender_tg_id, sender_name, recipient_tg_id, recipient_username,
           recipient_name, ticker, symbol, token_address, amount_usd, share_price, token_price, company_name, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?)`,
      )
      .run(
        id, t.chatId, t.senderTgId, t.senderName, t.recipientTgId, t.recipientUsername,
        t.recipientName, t.ticker, t.symbol, t.tokenAddress, t.amountUsd, t.sharePrice, t.tokenPrice, t.companyName, now, now,
      );
    return this.tip(id)!;
  }

  tip(id: string): TipRow | undefined {
    return this.db.prepare(`SELECT * FROM tips WHERE id = ?`).get(id) as TipRow | undefined;
  }

  setMessageId(id: string, messageId: number): void {
    this.db.prepare(`UPDATE tips SET message_id = ?, updated_at = ? WHERE id = ?`).run(messageId, Date.now(), id);
  }

  /**
   * Moves a tip between states only if it is currently in `from`. Returns false if another
   * request got there first, which makes every transition safe to retry.
   */
  transition(id: string, from: TipStatus, to: TipStatus, fields: Partial<TipRow> = {}): boolean {
    const allowed = ["onchain_tip_id", "token_amount", "pay_tx", "claim_tx", "claim_wallet", "recipient_tg_id"] as const;
    const sets = ["status = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [to, Date.now()];
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        values.push((fields[key] ?? null) as string | number | null);
      }
    }
    const result = this.db
      .prepare(`UPDATE tips SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
      .run(...values, id, from);
    return result.changes === 1;
  }

  /** Tips still waiting for payment after the pay window. */
  stalePending(olderThanMs: number): TipRow[] {
    return this.db
      .prepare(`SELECT * FROM tips WHERE status = 'awaiting_payment' AND created_at < ?`)
      .all(Date.now() - olderThanMs) as unknown as TipRow[];
  }

  byStatus(status: TipStatus): TipRow[] {
    return this.db.prepare(`SELECT * FROM tips WHERE status = ?`).all(status) as unknown as TipRow[];
  }

  /**
   * Tips this user sent, plus funded tips they received (by Telegram id, or by username before
   * they were linked). Recipients never see tips the sender hasn't paid for.
   */
  tipsForUser(tgId: number, username: string | undefined, limit = 50): TipRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tips
         WHERE status != 'cancelled'
           AND (sender_tg_id = ?
                OR (status != 'awaiting_payment'
                    AND (recipient_tg_id = ?
                         OR (recipient_tg_id IS NULL AND ? IS NOT NULL AND lower(recipient_username) = lower(?)))))
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(tgId, tgId, username ?? null, username ?? null, limit) as unknown as TipRow[];
  }

  close(): void {
    this.db.close();
  }
}
