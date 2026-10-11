import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCreateWallet, useLoginWithTelegram, usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, createWalletClient, custom, formatUnits, http, parseAbi, type Hex } from "viem";
import { bsc } from "viem/chains";
import type { TxRequest } from "./api";

export const USDT = "0x55d398326f99059fF775485246999027B3197955" as const;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export const publicClient = createPublicClient({ chain: bsc, transport: http("https://bsc-dataseed.bnbchain.org") });

export interface Balances {
  usdt: number;
  bnb: number;
}

export interface WalletApi {
  status: "loading" | "signed_out" | "creating_wallet" | "ready";
  address: Hex | null;
  login(): Promise<void>;
  /** Sends a transaction from the user's wallet and waits until it's mined. */
  send(tx: TxRequest): Promise<Hex>;
  balances(): Promise<Balances>;
}

const WalletContext = createContext<WalletApi | null>(null);

export function useWallet(): WalletApi {
  const w = useContext(WalletContext);
  if (!w) throw new Error("useWallet outside a wallet provider");
  return w;
}

async function readBalances(address: Hex): Promise<Balances> {
  const [usdt, bnb] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [address] }),
    publicClient.getBalance({ address }),
  ]);
  return { usdt: Number(formatUnits(usdt, 18)), bnb: Number(formatUnits(bnb, 18)) };
}

/** The user's Privy embedded wallet, created from their Telegram login. */
export function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { login: loginWithTelegram } = useLoginWithTelegram();
  const { createWallet } = useCreateWallet();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const creating = useRef(false);

  // createOnLogin should make the wallet; this covers users who logged in before that was set.
  useEffect(() => {
    if (ready && authenticated && walletsReady && !embedded && !creating.current) {
      creating.current = true;
      createWallet().catch((e) => console.error("createWallet", e)).finally(() => (creating.current = false));
    }
  }, [ready, authenticated, walletsReady, embedded, createWallet]);

  const send = useCallback(
    async (tx: TxRequest) => {
      if (!embedded) throw new Error("Wallet not ready");
      await embedded.switchChain(bsc.id);
      const client = createWalletClient({
        account: embedded.address as Hex,
        chain: bsc,
        transport: custom(await embedded.getEthereumProvider()),
      });
      const hash = await client.sendTransaction({ to: tx.to, data: tx.data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("The transaction failed on-chain.");
      return hash;
    },
    [embedded],
  );

  const value = useMemo<WalletApi>(
    () => ({
      status: !ready ? "loading" : !authenticated ? "signed_out" : !embedded ? "creating_wallet" : "ready",
      address: (embedded?.address as Hex | undefined) ?? null,
      login: () => loginWithTelegram(),
      send,
      balances: () => (embedded ? readBalances(embedded.address as Hex) : Promise.resolve({ usdt: 0, bnb: 0 })),
    }),
    [ready, authenticated, embedded, loginWithTelegram, send],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Preview stand-in: a fake wallet that "sends" instantly. */
export function MockWalletProvider({ children }: { children: ReactNode }) {
  const [address] = useState<Hex>("0x7a3F9e21C0b5d4A8E6f1c2B39d8E4a5F6b7C1d2E");
  const value = useMemo<WalletApi>(
    () => ({
      status: "ready",
      address,
      login: async () => {},
      send: async () => {
        await new Promise((r) => setTimeout(r, 900));
        return "0x9f2c4b7a1e3d5f60718293a4b5c6d7e8f9012345678901234567890abcdef123" as Hex;
      },
      balances: async () => ({ usdt: 12.5, bnb: 0.004 }),
    }),
    [address],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
