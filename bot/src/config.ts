function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}. See .env.example.`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
}

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  /** Short name of the Mini App registered with @BotFather (/newapp). */
  miniAppShortName: process.env.MINI_APP_SHORT_NAME ?? "app",
  /** Comma-separated DNS servers, for networks whose resolver blocks binance.com. */
  dnsServers: (process.env.DNS_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  dbPath: process.env.DB_PATH ?? "stocktip.db",
  apiPort: number("API_PORT", 8787),
  minTipUsd: number("MIN_TIP_USD", 1),
  maxTipUsd: number("MAX_TIP_USD", 50),
  /** Minutes a tip card waits for the sender to pay before it's cancelled. */
  payWindowMinutes: number("PAY_WINDOW_MINUTES", 30),

  rpcUrl: process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org",
  /** TipEscrow address. Until it's set, the bot runs but the Mini App API stays off. */
  escrowAddress: (process.env.ESCROW_ADDRESS || null) as `0x${string}` | null,
  /** "agentic-wallet" (baw CLI) or "private-key" (local testing). */
  operatorKind: (process.env.OPERATOR || "agentic-wallet") as "agentic-wallet" | "private-key",
  operatorAddress: (process.env.OPERATOR_ADDRESS || null) as `0x${string}` | null,
  operatorPrivateKey: (process.env.OPERATOR_PRIVATE_KEY || null) as `0x${string}` | null,
  corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};

export type Config = typeof config;
