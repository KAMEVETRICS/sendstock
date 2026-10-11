// Shown on sendstock.website outside Telegram. Black, minimal, mono labels in the corners,
// a faint BNB mark in the background and orbits around the SendStock icon.

/** BNB Chain mark: a center diamond, two side diamonds and top/bottom chevrons. */
function BnbMark() {
  const d = (cx: number, cy: number, r: number) => `M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z`;
  const chevron = (rot: number) => (
    <path transform={`rotate(${rot} 500 500)`} d="M500 140 L640 280 L580 340 L500 260 L420 340 L360 280 Z" />
  );
  return (
    <svg className="landing-bnb" viewBox="0 0 1000 1000" aria-hidden>
      <g fill="#F0B90B">
        <path d={d(500, 500, 85)} />
        <path d={d(270, 500, 60)} />
        <path d={d(730, 500, 60)} />
        {chevron(0)}
        {chevron(180)}
      </g>
    </svg>
  );
}

export function Landing() {
  return (
    <main className="landing">
      <BnbMark />
      <div className="landing-grain" aria-hidden />

      <header className="landing-top">
        <div className="mono">SENDSTOCK</div>
        <div className="mono dim landing-col">
          STOCKS, SENT
          <br />
          TOKENIZED US EQUITIES ON BNB CHAIN
        </div>
        <div className="mono landing-right">
          <b>SENDSTOCK IS TIPPING, EVOLVED.</b> <span className="dim">SEND A FRIEND REAL SHARES IN TELEGRAM. NO SEED PHRASE, NO GAS.</span>
        </div>
        <div className="mono">GLOBAL</div>
      </header>

      <section className="landing-center">
        <svg className="landing-orbits" viewBox="0 0 800 800" aria-hidden>
          <g fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2">
            <ellipse cx="400" cy="400" rx="330" ry="120" transform="rotate(-28 400 400)" />
            <ellipse cx="400" cy="400" rx="330" ry="120" transform="rotate(28 400 400)" />
            <ellipse cx="400" cy="400" rx="130" ry="340" />
          </g>
          <g fill="rgba(255,255,255,0.6)" fontFamily="ui-monospace, monospace" fontSize="12">
            <text x="200" y="160">0</text>
            <text x="590" y="170">0</text>
            <text x="120" y="440">NVDA</text>
            <text x="640" y="470">TSLA</text>
            <text x="300" y="690">AAPL</text>
            <text x="470" y="700">SPY</text>
          </g>
        </svg>
        <img className="landing-icon" src="/icon.svg" alt="SendStock" />
      </section>

      <section className="landing-cta">
        <h1>Tip friends real US stocks.</h1>
        <p className="dim">Message the bot <code>/send 5 NVDA</code>, pick a friend, done. They claim in one tap.</p>
        <a className="landing-button" href="https://t.me/Sendstockbot">Open @Sendstockbot</a>
      </section>

      <footer className="landing-bottom">
        <div className="mono">FUTURE</div>
        <div className="mono dim">BNB HACK · TOKENIZED STOCKS EDITION</div>
        <div className="mono">24/7</div>
      </footer>
    </main>
  );
}
