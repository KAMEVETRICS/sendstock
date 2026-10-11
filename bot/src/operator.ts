import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

const exec = promisify(execFile);

export type SubmitResult =
  | { status: "broadcast"; txHash: Hex }
  /** Agentic Wallet wants the owner to approve in the Binance App. The claim watcher finishes it. */
  | { status: "pending_app_confirmation" };

/** The wallet allowed to call TipEscrow.claim. */
export interface Operator {
  readonly kind: string;
  readonly address: Address;
  call(to: Address, data: Hex): Promise<SubmitResult>;
}

/** Binance Agentic Wallet, driven through the `baw` CLI (needs Developer Mode on in the Binance App). */
export class AgenticWalletOperator implements Operator {
  readonly kind = "agentic-wallet";

  constructor(readonly address: Address) {}

  private async baw<T>(args: string[]): Promise<T> {
    const { stdout } = await exec("baw", [...args, "--json"], {
      timeout: 120_000,
      shell: process.platform === "win32", // baw is a .cmd shim on Windows
    });
    const out = JSON.parse(stdout) as { success: boolean; data?: T; error?: { code: number; name: string; message: string } };
    if (!out.success || !out.data) {
      const e = out.error;
      throw new Error(`baw ${args.slice(0, 2).join(" ")} failed: ${e ? `${e.name} (${e.code}): ${e.message}` : stdout}`);
    }
    return out.data;
  }

  /**
   * Agentic Wallet signs out after 48h without activity; any call pushes that back 48h. Run this
   * every few hours so the server stays signed in (up to the max sign-in length set in the app).
   */
  async keepAlive(): Promise<{ connected: boolean; devModeUntil: string | null }> {
    const status = await this.baw<{ status: string }>(["wallet", "status"]);
    if (status.status !== "CONNECTED") return { connected: false, devModeUntil: null };
    const settings = await this.baw<{ devMode?: { enabled: boolean; expiresAt: string | null } }>(["wallet", "settings"]);
    return { connected: true, devModeUntil: settings.devMode?.enabled ? settings.devMode.expiresAt : null };
  }

  async call(to: Address, data: Hex): Promise<SubmitResult> {
    const preview = await this.baw<{
      requestId?: string;
      simulationResult?: { simulationCode: string; simulationErrorDetail: string | null };
      risks?: { riskDetails?: { code: string; title: string; riskType: string }[] };
    }>(["contract-call", "preview", "--binanceChainId", "56", "--from", this.address, "--to", to, "--value", "0", "--inputData", data]);

    const sim = preview.simulationResult;
    if (sim && sim.simulationCode !== "000000000") {
      throw new Error(`Agentic Wallet simulation failed: ${sim.simulationErrorDetail ?? sim.simulationCode}`);
    }
    const risks = preview.risks?.riskDetails?.filter((r) => r.riskType === "RISK") ?? [];
    if (risks.length > 0) {
      // Our own escrow should never be flagged. If it is, stop and let a human look.
      throw new Error(`Agentic Wallet flagged the call: ${risks.map((r) => `${r.code} ${r.title}`).join("; ")}`);
    }
    if (!preview.requestId) throw new Error("Agentic Wallet preview returned no requestId");

    const result = await this.baw<{ status: string; txHash: Hex | null; message: string | null }>([
      "contract-call", "execute", "--requestId", preview.requestId,
    ]);
    if (result.txHash) return { status: "broadcast", txHash: result.txHash };
    if (result.status === "PENDING_CONFIRMATION") return { status: "pending_app_confirmation" };
    throw new Error(`Agentic Wallet execute returned ${result.status}: ${result.message ?? "no message"}`);
  }
}

/** Plain private-key wallet, for local testing before Agentic Wallet is set up. */
export class KeyOperator implements Operator {
  readonly kind = "private-key";
  readonly address: Address;
  private wallet;

  constructor(privateKey: Hex, rpcUrl: string) {
    const account = privateKeyToAccount(privateKey);
    this.address = account.address;
    this.wallet = createWalletClient({ account, chain: bsc, transport: http(rpcUrl) });
  }

  async call(to: Address, data: Hex): Promise<SubmitResult> {
    const txHash = await this.wallet.sendTransaction({ to, data });
    return { status: "broadcast", txHash };
  }
}
