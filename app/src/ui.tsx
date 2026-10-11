import { useState, type ReactNode } from "react";

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Fractional shares with enough digits that small tips don't show as 0.00. */
export function shares(n: number): string {
  if (n >= 1) return n.toFixed(3);
  const digits = Math.min(8, Math.max(4, 2 - Math.floor(Math.log10(n))));
  return n.toFixed(digits);
}

export const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
export const bscscanTx = (hash: string) => `https://bscscan.com/tx/${hash}`;

export function Screen({ children }: { children: ReactNode }) {
  return <main className="screen">{children}</main>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center">
      <div className="spinner" aria-hidden />
      {label && <p className="hint">{label}</p>}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "success"; children: ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>{children}</div>;
}

export function StockBadge({ ticker, iconUrl }: { ticker: string; iconUrl?: string | null }) {
  const [broken, setBroken] = useState(false);
  return iconUrl && !broken ? (
    <img className="logo" src={iconUrl} alt="" onError={() => setBroken(true)} />
  ) : (
    <div className="logo logo-fallback" aria-hidden>{ticker.slice(0, 1)}</div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="hint">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="link-button mono"
      onClick={() => {
        navigator.clipboard?.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied ✓" : `${short(address)} ⧉`}
    </button>
  );
}

const SESSION: Record<string, string> = {
  premarket: "US pre-market",
  regular: "US market open",
  afterhours: "US after-hours",
  overnight: "US overnight session",
  closed: "US market closed",
};

export function MarketBadge({ session, open }: { session: string | null; open: boolean }) {
  const label = (session && SESSION[session]) ?? (open ? "US market open" : "US market closed");
  const live = session === "regular";
  return (
    <span className={`pill ${live ? "pill-live" : ""}`} title="The stock token trades on-chain 24/7, even when Wall Street is closed.">
      {live ? "●" : "☾"} {label}
    </span>
  );
}
