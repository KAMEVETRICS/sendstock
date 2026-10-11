import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";

export const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
const USDT_DECIMALS = 18;

/** PancakeSwap v3 on BSC. */
export const PCS_V3_ROUTER: Address = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
export const PCS_V3_QUOTER: Address = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const FEE_TIERS = [100, 500, 2500, 10000] as const;

export const TIP_DURATION_SEC = 7 * 24 * 3600;
const SLIPPAGE_BPS = 100n; // 1%

export const escrowAbi = parseAbi([
  "struct Tip { address sender; uint64 expiry; bool settled; address token; uint256 amount; bytes32 recipientHash; }",
  "function tip(address token, uint256 amount, bytes32 recipientHash, uint64 expiry) returns (uint256)",
  "function tipWithSwap(address tokenIn, uint256 amountIn, address tokenOut, address router, bytes swapData, uint256 minOut, bytes32 recipientHash, uint64 expiry) returns (uint256)",
  "function claim(uint256 tipId, address to)",
  "function refund(uint256 tipId)",
  "function getTip(uint256 tipId) view returns (Tip)",
  "function operator() view returns (address)",
  "event Tipped(uint256 indexed tipId, address indexed sender, address indexed token, uint256 amount, bytes32 recipientHash, uint64 expiry)",
  "event Claimed(uint256 indexed tipId, address indexed to)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const routerAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

/**
 * Ties an on-chain tip to one row in our database. Opaque on-chain, so no Telegram ids leak,
 * and a payment for one tip can never be replayed as payment for another.
 */
export function recipientHash(tipId: string): Hex {
  return keccak256(toBytes(`stocktip:${tipId}`));
}

export interface TxRequest {
  to: Address;
  data: Hex;
}

export interface PayPlan {
  wallet: Address;
  amountIn: string; // USDT, human units
  usdtBalance: string;
  enoughBalance: boolean;
  approveTx: TxRequest | null;
  tipTx: TxRequest;
  expectedOut: string; // stock tokens, human units
  minOut: string;
  poolFeeBps: number;
}

export interface VerifiedPayment {
  onchainTipId: number;
  tokenAmount: bigint;
  sender: Address;
}

export class PaymentError extends Error {}

export class Chain {
  readonly client;

  constructor(
    rpcUrl: string,
    readonly escrow: Address,
    opts: { timeoutMs?: number } = {},
  ) {
    this.client = createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: opts.timeoutMs ?? 15_000 }) });
  }

  /** Best single-pool USDT → stock quote across PancakeSwap v3 fee tiers. */
  async bestQuote(token: Address, amountIn: bigint): Promise<{ fee: number; out: bigint }> {
    const results = await Promise.allSettled(
      FEE_TIERS.map(async (fee) => {
        const { result } = await this.client.simulateContract({
          address: PCS_V3_QUOTER,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: USDT, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        return { fee, out: result[0] };
      }),
    );
    let best: { fee: number; out: bigint } | null = null;
    for (const r of results) if (r.status === "fulfilled" && (!best || r.value.out > best.out)) best = r.value;
    if (!best || best.out === 0n) throw new PaymentError("No PancakeSwap pool can fill this swap right now.");
    return best;
  }

  /** Everything the Mini App needs to send: an approve (if needed) and the tip itself. */
  async planPayment(opts: {
    tipId: string;
    wallet: Address;
    token: Address;
    tokenDecimals: number;
    amountUsd: number;
  }): Promise<PayPlan> {
    const amountIn = parseUnits(opts.amountUsd.toFixed(2), USDT_DECIMALS);
    const [quote, balance, allowance, block] = await Promise.all([
      this.bestQuote(opts.token, amountIn),
      this.client.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [opts.wallet] }),
      this.client.readContract({ address: USDT, abi: erc20Abi, functionName: "allowance", args: [opts.wallet, this.escrow] }),
      this.client.getBlock(),
    ]);

    const minOut = (quote.out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const now = block.timestamp;
    const swapData = encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: USDT,
        tokenOut: opts.token,
        fee: quote.fee,
        recipient: this.escrow,
        deadline: now + 20n * 60n,
        amountIn,
        amountOutMinimum: 0n, // the escrow enforces minOut on what it actually receives
        sqrtPriceLimitX96: 0n,
      }],
    });

    return {
      wallet: opts.wallet,
      amountIn: formatUnits(amountIn, USDT_DECIMALS),
      usdtBalance: formatUnits(balance, USDT_DECIMALS),
      enoughBalance: balance >= amountIn,
      approveTx:
        allowance >= amountIn
          ? null
          : {
              to: USDT,
              // Exact amount, not unlimited: the escrow only ever needs what this tip spends.
              data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.escrow, amountIn] }),
            },
      tipTx: {
        to: this.escrow,
        data: encodeFunctionData({
          abi: escrowAbi,
          functionName: "tipWithSwap",
          args: [
            USDT, amountIn, opts.token, PCS_V3_ROUTER, swapData, minOut,
            recipientHash(opts.tipId), now + BigInt(TIP_DURATION_SEC),
          ],
        }),
      },
      expectedOut: formatUnits(quote.out, opts.tokenDecimals),
      minOut: formatUnits(minOut, opts.tokenDecimals),
      poolFeeBps: quote.fee / 100,
    };
  }

  /**
   * Confirms a payment transaction really escrowed this tip: it succeeded, emitted Tipped from our
   * escrow with this tip's recipientHash, for the right stock, and for at least `minTokens`.
   */
  async verifyPayment(txHash: Hex, opts: { tipId: string; token: Address; minTokens: bigint }): Promise<VerifiedPayment> {
    const receipt = await this.client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") throw new PaymentError("That transaction failed on-chain.");

    const expectedHash = recipientHash(opts.tipId);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.escrow.toLowerCase()) continue;
      let event;
      try {
        event = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      if (event.eventName !== "Tipped" || event.args.recipientHash !== expectedHash) continue;
      if (event.args.token.toLowerCase() !== opts.token.toLowerCase()) {
        throw new PaymentError("That payment was for a different stock.");
      }
      if (event.args.amount < opts.minTokens) throw new PaymentError("That payment was smaller than the tip.");
      return { onchainTipId: Number(event.args.tipId), tokenAmount: event.args.amount, sender: event.args.sender };
    }
    throw new PaymentError("That transaction didn't pay for this tip.");
  }

  async isSettled(onchainTipId: number): Promise<boolean> {
    const tip = await this.client.readContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "getTip",
      args: [BigInt(onchainTipId)],
    });
    return tip.settled;
  }

  claimCalldata(onchainTipId: number, to: Address): Hex {
    return encodeFunctionData({ abi: escrowAbi, functionName: "claim", args: [BigInt(onchainTipId), to] });
  }
}
