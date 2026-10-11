import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type PayPlan, type StockInfo, type Tip } from "./api";
import { tg } from "./telegram";
import { useWallet, type Balances } from "./wallet";
import { bscscanTx, CopyAddress, MarketBadge, Notice, Row, Screen, shares, Spinner, StockBadge, usd } from "./ui";

const MIN_BNB_FOR_GAS = 0.0003; // two BSC transactions with headroom

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/rejected|denied|cancel/i.test(msg)) return "You cancelled the transaction.";
  if (/insufficient funds/i.test(msg)) return "Not enough BNB for gas. Add a little BNB to your wallet and try again.";
  return "Something went wrong. Please try again.";
}

function useTip(id: string) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => api.tip(id).then(setTip, (e) => setError(errorText(e))), [id]);
  useEffect(() => void reload(), [reload]);
  return { tip, setTip, error, reload };
}

/** Shown until Privy has logged the user in and made their wallet. */
function WalletGate({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);
  if (wallet.status === "loading") return <Spinner label="Loading…" />;
  if (wallet.status === "creating_wallet") return <Spinner label="Setting up your wallet…" />;
  if (wallet.status === "signed_out") {
    return (
      <div className="center stack">
        <p>Sign in with Telegram to get your wallet. No seed phrase needed.</p>
        <button className="button" onClick={() => wallet.login().catch((e) => setError(errorText(e)))}>
          Continue with Telegram
        </button>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    );
  }
  return <>{children}</>;
}

function TipHeadline({ tip, iconUrl }: { tip: Tip; iconUrl?: string | null }) {
  return (
    <header className="headline">
      <StockBadge ticker={tip.ticker} iconUrl={iconUrl} />
      <div>
        <h1>
          {usd(tip.amountUsd)} of {tip.companyName}
        </h1>
        <p className="hint">
          {tip.senderName} → {tip.recipientName}
        </p>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------------------------- pay

type PayStep = "idle" | "approving" | "paying" | "confirming" | "done";
const STEP_LABEL: Record<PayStep, string> = {
  idle: "",
  approving: "Approving USDT (1 of 2)…",
  paying: "Sending your tip (2 of 2)…",
  confirming: "Confirming on BNB Chain…",
  done: "",
};

export function PayScreen({ tipId }: { tipId: string }) {
  const { tip, setTip, error } = useTip(tipId);
  if (error) return <Screen><Notice tone="error">{error}</Notice></Screen>;
  if (!tip) return <Screen><Spinner /></Screen>;

  if (tip.role !== "sender") {
    return (
      <Screen>
        <TipHeadline tip={tip} />
        <Notice>Only {tip.senderName} can pay for this tip.</Notice>
      </Screen>
    );
  }
  if (tip.status !== "awaiting_payment") return <Screen><PaidView tip={tip} /></Screen>;

  return (
    <Screen>
      <TipHeadline tip={tip} />
      <WalletGate>
        <PayForm tip={tip} onPaid={setTip} />
      </WalletGate>
    </Screen>
  );
}

function PayForm({ tip, onPaid }: { tip: Tip; onPaid: (t: Tip) => void }) {
  const wallet = useWallet();
  const [plan, setPlan] = useState<PayPlan | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [step, setStep] = useState<PayStep>("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet.address) return;
    setError(null);
    try {
      const [p, b] = await Promise.all([api.plan(tip.id, wallet.address), wallet.balances()]);
      setPlan(p);
      setBalances(b);
    } catch (e) {
      setError(errorText(e));
    }
  }, [tip.id, wallet]);

  useEffect(() => void refresh(), [refresh]);

  async function pay() {
    if (!plan) return;
    setError(null);
    try {
      if (plan.approveTx) {
        setStep("approving");
        await wallet.send(plan.approveTx);
      }
      setStep("paying");
      const hash = await wallet.send(plan.tipTx);
      setStep("confirming");
      onPaid(await api.paid(tip.id, hash));
      tg.haptic("success");
      setStep("done");
    } catch (e) {
      tg.haptic("error");
      setError(errorText(e));
      setStep("idle");
      void refresh(); // the approval may have gone through even if the tip didn't
    }
  }

  if (!plan || !balances) return error ? <Notice tone="error">{error}</Notice> : <Spinner label="Getting the best price…" />;

  const lowGas = balances.bnb < MIN_BNB_FOR_GAS;
  const busy = step !== "idle";

  return (
    <div className="stack">
      <section className="card">
        <Row label="They get">≈ {shares(Number(plan.expectedOut))} {tip.ticker}</Row>
        <Row label="You pay">{usd(Number(plan.amountIn))} USDT</Row>
        <Row label="Pool fee">{(plan.poolFeeBps / 100).toFixed(2)}% · PancakeSwap</Row>
        <Row label="Network">BNB Chain</Row>
      </section>

      <section className="card">
        <Row label="Your wallet">{wallet.address && <CopyAddress address={wallet.address} />}</Row>
        <Row label="USDT">{balances.usdt.toFixed(2)}</Row>
        <Row label="BNB (gas)">{balances.bnb.toFixed(4)}</Row>
      </section>

      {!plan.enoughBalance && (
        <Notice tone="warn">
          You need {usd(Number(plan.amountIn))} USDT on <b>BNB Chain (BEP-20)</b>. Send some to your wallet address above, then
          refresh.
        </Notice>
      )}
      {lowGas && <Notice tone="warn">Add a little BNB (about $0.10) to the same address to pay network fees.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {busy ? (
        <Spinner label={STEP_LABEL[step]} />
      ) : !plan.enoughBalance || lowGas ? (
        <button className="button button-secondary" onClick={refresh}>Refresh balance</button>
      ) : (
        <button className="button" onClick={pay}>
          Send {usd(tip.amountUsd)} of {tip.ticker}
        </button>
      )}
      <p className="hint small">
        Unclaimed tips come back to you after 7 days. {plan.approveTx ? "You'll confirm two transactions." : ""}
      </p>
    </div>
  );
}

function PaidView({ tip }: { tip: Tip }) {
  const text: Record<string, string> = {
    escrowed: `Sent! ${tip.recipientName} can claim it now.`,
    claiming: `${tip.recipientName} is claiming it.`,
    claimed: `${tip.recipientName} claimed it. 🎉`,
    cancelled: "This tip was cancelled.",
    refunded: "This tip was returned to you.",
  };
  return (
    <div className="stack">
      <TipHeadline tip={tip} />
      <Notice tone={tip.status === "cancelled" ? "info" : "success"}>{text[tip.status] ?? tip.status}</Notice>
      {tip.payTx && (
        <button className="link-button" onClick={() => tg.openLink(bscscanTx(tip.payTx!))}>View payment on BscScan ↗</button>
      )}
      <button className="button button-secondary" onClick={() => tg.close()}>Back to chat</button>
    </div>
  );
}

// ----------------------------------------------------------------------------------- claim

export function ClaimScreen({ tipId }: { tipId: string }) {
  const { tip, setTip, error, reload } = useTip(tipId);
  const [stock, setStock] = useState<StockInfo | null>(null);

  useEffect(() => void api.stock(tipId).then(setStock, () => setStock(null)), [tipId]);

  // A claim through the Agentic Wallet can wait for approval; poll until it lands.
  useEffect(() => {
    if (tip?.status !== "claiming") return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [tip?.status, reload]);

  if (error) return <Screen><Notice tone="error">{error}</Notice></Screen>;
  if (!tip) return <Screen><Spinner /></Screen>;

  return (
    <Screen>
      <TipHeadline tip={tip} iconUrl={stock?.meta?.iconUrl} />
      {stock && <StockCard tip={tip} stock={stock} />}
      {tip.role !== "recipient" ? (
        <Notice>This tip is for {tip.recipientName}.</Notice>
      ) : tip.status === "awaiting_payment" ? (
        <Notice>{tip.senderName} hasn't sent this tip yet.</Notice>
      ) : tip.status === "escrowed" ? (
        <WalletGate>
          <ClaimButton tip={tip} onClaimed={setTip} />
        </WalletGate>
      ) : tip.status === "claiming" ? (
        <Spinner label="Your shares are on their way…" />
      ) : tip.status === "claimed" ? (
        <Claimed tip={tip} stock={stock} />
      ) : (
        <Notice>This tip expired and went back to {tip.senderName}.</Notice>
      )}
    </Screen>
  );
}

function StockCard({ tip, stock }: { tip: Tip; stock: StockInfo }) {
  const change = stock.changePct24h;
  return (
    <section className="card stack-sm">
      <div className="row">
        <span>
          <b>{shares(stock.tokens)} {tip.ticker}</b>
          {stock.valueNowUsd !== null && <span className="hint"> · worth {usd(stock.valueNowUsd)} now</span>}
        </span>
        {change !== null && <span className={change >= 0 ? "up" : "down"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}% 24h</span>}
      </div>
      {stock.market && <MarketBadge session={stock.market.session} open={stock.market.open} />}
      {stock.meta?.description && <p className="description">{stock.meta.description}</p>}
      {stock.meta?.attestationUrl && (
        <button className="link-button small" onClick={() => tg.openLink(stock.meta!.attestationUrl!)}>
          Proof the shares are held 1:1 ↗
        </button>
      )}
    </section>
  );
}

function ClaimButton({ tip, onClaimed }: { tip: Tip; onClaimed: (t: Tip) => void }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function claim() {
    if (!wallet.address) return;
    setBusy(true);
    setError(null);
    try {
      onClaimed(await api.claim(tip.id, wallet.address));
      tg.haptic("success");
    } catch (e) {
      tg.haptic("error");
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error && <Notice tone="error">{error}</Notice>}
      {busy ? (
        <Spinner label="Claiming…" />
      ) : (
        <button className="button" onClick={claim}>Claim my {tip.ticker} shares</button>
      )}
      <p className="hint small">Free: we cover the network fee. Your shares go to your own wallet.</p>
    </div>
  );
}

function Claimed({ tip, stock }: { tip: Tip; stock: StockInfo | null }) {
  return (
    <div className="stack">
      <Notice tone="success">
        🎉 You own {stock ? shares(stock.tokens) : ""} {tip.ticker}. It's in your wallet, and it trades 24/7.
      </Notice>
      {tip.claimWallet && <Row label="Your wallet"><CopyAddress address={tip.claimWallet} /></Row>}
      {tip.claimTx && (
        <button className="link-button" onClick={() => tg.openLink(bscscanTx(tip.claimTx!))}>View on BscScan ↗</button>
      )}
      <button className="button button-secondary" onClick={() => tg.close()}>Back to chat</button>
    </div>
  );
}

// -------------------------------------------------------------------------------- my tips

const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: "Not paid yet",
  escrowed: "Waiting to be claimed",
  claiming: "Claiming…",
  claimed: "Claimed",
  refunded: "Returned",
};

export function MyTipsScreen() {
  const [tips, setTips] = useState<Tip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.myTips().then(setTips, (e) => setError(errorText(e))), []);

  return (
    <Screen>
      <h1>Your tips</h1>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !tips ? (
        <Spinner />
      ) : tips.length === 0 ? (
        <p className="hint">No tips yet. In a group, try <code>/tip @friend 5 NVDA</code>.</p>
      ) : (
        <ul className="list">
          {tips.map((t) => (
            <li key={t.id} className="card row">
              <span>
                <b>{usd(t.amountUsd)} {t.ticker}</b>
                <span className="hint small"> · {t.role === "sender" ? `to ${t.recipientName}` : `from ${t.senderName}`}</span>
              </span>
              <span className="hint small">{STATUS_LABEL[t.status] ?? t.status}</span>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}
