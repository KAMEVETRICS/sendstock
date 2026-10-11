// Client for Binance Web3's public RWA (tokenized stock) endpoints. No API key needed.

const BASE = "https://www.binance.com/bapi/defi";
const BSTOCK_TYPE = 3;
const BSC_CHAIN_ID = "56";
const LIST_TTL_MS = 10 * 60_000;

export interface BStock {
  symbol: string; // NVDAB
  ticker: string; // NVDA
  address: `0x${string}`;
  decimals: number;
  /** Shares of the underlying per token (dividend adjustments, splits). */
  multiplier: number;
}

export interface StockMeta {
  name: string;
  companyName: string;
  description: string;
  industry: string;
  iconUrl: string | null;
  attestationUrl: string | null;
}

export interface StockQuote {
  /** USD price of one token on-chain. */
  tokenPrice: number;
  /** tokenPrice / multiplier: implied price of one underlying share. */
  sharePrice: number;
  changePct24h: number | null;
  tradable: boolean;
  statusReason: string | null;
}

export interface MarketStatus {
  /** e.g. "premarket", "regular", "afterhours", "closed"; null when the API doesn't say. */
  session: string | null;
  open: boolean;
  nextOpen: Date | null;
  nextClose: Date | null;
}

interface Envelope<T> {
  code: string;
  message: string | null;
  data: T;
  success: boolean;
}

export class RwaError extends Error {}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "Accept-Encoding": "identity", "User-Agent": "stocktip/0.1" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new RwaError(`RWA API ${path} returned HTTP ${res.status}`);
  const body = (await res.json()) as Envelope<T>;
  if (!body.success || body.code !== "000000") {
    throw new RwaError(`RWA API ${path} failed: ${body.code} ${body.message ?? ""}`.trim());
  }
  return body.data;
}

/** Absolute URLs pass through; relative paths get the static-asset host, per the docs. */
function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith("http") ? path : `https://bin.bnbstatic.com${path}`;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class RwaClient {
  private list: { at: number; stocks: BStock[] } | null = null;

  async listBStocks(): Promise<BStock[]> {
    if (this.list && Date.now() - this.list.at < LIST_TTL_MS) return this.list.stocks;
    const raw = await get<Array<Record<string, string | number>>>(
      "/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai",
      { type: String(BSTOCK_TYPE) },
    );
    const stocks = raw
      .filter((r) => String(r.chainId) === BSC_CHAIN_ID && Number(r.type) === BSTOCK_TYPE)
      .map((r) => ({
        symbol: String(r.symbol),
        ticker: String(r.ticker),
        address: String(r.contractAddress) as `0x${string}`,
        decimals: Number(r.d ?? 18),
        multiplier: toNumber(r.multiplier) ?? 1,
      }));
    this.list = { at: Date.now(), stocks };
    return stocks;
  }

  /** Accepts a ticker ("NVDA") or a bStock symbol ("NVDAB"), case-insensitive. */
  async resolve(input: string): Promise<BStock | null> {
    const q = input.trim().toUpperCase().replace(/^\$/, "");
    const stocks = await this.listBStocks();
    return stocks.find((s) => s.ticker.toUpperCase() === q) ?? stocks.find((s) => s.symbol.toUpperCase() === q) ?? null;
  }

  async meta(stock: BStock): Promise<StockMeta> {
    const d = await get<Record<string, any>>("/v1/public/wallet-direct/buw/wallet/market/token/rwa/meta/ai", {
      chainId: BSC_CHAIN_ID,
      contractAddress: stock.address,
    });
    const c = d.companyInfo ?? {};
    return {
      name: d.name ?? stock.symbol,
      companyName: c.companyName ?? stock.ticker,
      description: c.description ?? "",
      industry: c.industry ?? "",
      iconUrl: assetUrl(d.icon),
      attestationUrl: assetUrl(d.dailyAttestationReports),
    };
  }

  async quote(stock: BStock): Promise<StockQuote> {
    const d = await get<Record<string, any>>("/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai", {
      chainId: BSC_CHAIN_ID,
      contractAddress: stock.address,
    });
    const tokenPrice = toNumber(d.tokenInfo?.price);
    if (tokenPrice === null || tokenPrice <= 0) throw new RwaError(`No price for ${stock.symbol}`);
    const multiplier = toNumber(d.tokenInfo?.sharesMultiplier) ?? stock.multiplier;
    return {
      tokenPrice,
      sharePrice: tokenPrice / multiplier,
      changePct24h: toNumber(d.tokenInfo?.priceChangePct24h),
      tradable: d.statusInfo?.openState !== false,
      statusReason: d.statusInfo?.reasonMsg ?? d.statusInfo?.reasonCode ?? null,
    };
  }

  async marketStatus(): Promise<MarketStatus> {
    const d = await get<Record<string, any>>("/v1/public/wallet-direct/buw/wallet/market/token/rwa/market/status/ai");
    const date = (ms: unknown) => (toNumber(ms) ? new Date(Number(ms)) : null);
    return {
      session: d.marketStatus ?? null,
      open: d.openState === true,
      nextOpen: date(d.nextOpenTime),
      nextClose: date(d.nextCloseTime),
    };
  }
}
