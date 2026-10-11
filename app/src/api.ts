import type { Hex } from "viem";
import { mockMode, tg } from "./telegram";

export type TipStatus = "awaiting_payment" | "escrowed" | "claiming" | "claimed" | "refunded" | "cancelled";

export interface Tip {
  id: string;
  role: "sender" | "recipient" | "viewer";
  status: TipStatus;
  senderName: string;
  recipientName: string;
  ticker: string;
  symbol: string;
  companyName: string;
  tokenAddress: string;
  amountUsd: number;
  sharePrice: number;
  tokenAmount: string | null;
  payTx: string | null;
  claimTx: string | null;
  claimWallet: string | null;
  createdAt: number;
}

export interface TxRequest {
  to: Hex;
  data: Hex;
}

export interface PayPlan {
  wallet: string;
  amountIn: string;
  usdtBalance: string;
  enoughBalance: boolean;
  approveTx: TxRequest | null;
  tipTx: TxRequest;
  expectedOut: string;
  minOut: string;
  poolFeeBps: number;
}

export interface StockInfo {
  meta: { companyName: string; description: string; industry: string; iconUrl: string | null; attestationUrl: string | null } | null;
  tokenPrice: number | null;
  sharePrice: number | null;
  changePct24h: number | null;
  valueNowUsd: number | null;
  tokens: number;
  market: { session: string | null; open: boolean } | null;
}

export class ApiError extends Error {}

async function request<T>(path: string, body?: object): Promise<T> {
  if (mockMode) return mock(path, body) as T;
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `tma ${tg.initData}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (json.error) throw new ApiError(json.error);
    if (res.status >= 502 && res.status <= 504) throw new ApiError("SendStock is restarting. Try again in a moment.");
    throw new ApiError(`Request failed (${res.status})`);
  }
  return json as T;
}

export const api = {
  tip: (id: string) => request<Tip>(`/api/tips/${id}`),
  stock: (id: string) => request<StockInfo>(`/api/tips/${id}/stock`),
  plan: (id: string, wallet: string) => request<PayPlan>(`/api/tips/${id}/plan`, { wallet }),
  paid: (id: string, txHash: string) => request<Tip>(`/api/tips/${id}/paid`, { txHash }),
  claim: (id: string, wallet: string) => request<Tip>(`/api/tips/${id}/claim`, { wallet }),
  myTips: () => request<Tip[]>(`/api/me/tips`),
};

// ------------------------------------------------------------------ preview mocks (dev only)

const mockTip: Tip = {
  id: "mockTip0001",
  role: mockMode === "claim" ? "recipient" : "sender",
  status: mockMode === "claim" ? "escrowed" : "awaiting_payment",
  senderName: "Kay",
  recipientName: "@alice_b",
  ticker: "NVDA",
  symbol: "NVDAB",
  companyName: "Nvidia Corp",
  tokenAddress: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436",
  amountUsd: 5,
  sharePrice: 237.84,
  tokenAmount: "21068527398637693",
  payTx: null,
  claimTx: null,
  claimWallet: null,
  createdAt: Date.now() - 120_000,
};

async function mock(path: string, body?: object): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 400));
  const fakeTx = { to: "0x0000000000000000000000000000000000000001", data: "0x" } as TxRequest;
  if (path.endsWith("/stock")) {
    return {
      meta: {
        companyName: "Nvidia Corp",
        industry: "Semiconductors",
        description:
          "Nvidia is a leading developer of graphics processing units, now central to AI: its GPUs and its Cuda software platform are used to train and run large language models.",
        iconUrl: null,
        attestationUrl: "https://www.binance.com/proof-of-collateral/bstocks",
      },
      tokenPrice: 239.1,
      sharePrice: 238.91,
      changePct24h: 1.24,
      valueNowUsd: 5.04,
      tokens: 0.021068,
      market: { session: "overnight", open: true },
    } satisfies StockInfo;
  }
  if (path.endsWith("/plan")) {
    return {
      wallet: (body as { wallet: string }).wallet,
      amountIn: "5",
      usdtBalance: "12.5",
      enoughBalance: true,
      approveTx: fakeTx,
      tipTx: fakeTx,
      expectedOut: "0.021068527398637693",
      minOut: "0.020857842124651316",
      poolFeeBps: 5,
    } satisfies PayPlan;
  }
  if (path.endsWith("/paid")) return { ...mockTip, status: "escrowed", payTx: "0xabc" };
  if (path.endsWith("/claim")) return { ...mockTip, status: "claimed", claimTx: "0xdef", claimWallet: (body as { wallet: string }).wallet };
  if (path === "/api/me/tips") {
    return [
      { ...mockTip, role: "recipient", status: "claimed", senderName: "Sam", recipientName: "@kay_s", ticker: "TSLA", companyName: "Tesla Inc", amountUsd: 10 },
      { ...mockTip, id: "mockTip0002", role: "sender", status: "escrowed" },
      { ...mockTip, id: "mockTip0003", role: "sender", status: "awaiting_payment", ticker: "AAPL", companyName: "Apple Inc", amountUsd: 2 },
    ];
  }
  return mockTip;
}
