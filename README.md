# SendStock

**Tip friends real US stocks, right inside Telegram.**

`/tip @alice 5 NVDA` in any Telegram group sends Alice $5 of Nvidia as a real tokenized stock (NVDAB, a Binance bStock on BNB Chain). She taps **Claim**, gets a wallet from her Telegram login (no seed phrase), and receives the shares without paying gas.

- **Live:** [sendstock.website](https://sendstock.website) · Telegram bot [@Sendstockbot](https://t.me/Sendstockbot)
- **Contract (BSC mainnet):** TipEscrow [`0xc6196B047901214437D9A4aB99024bc311050Ca1`](https://bscscan.com/address/0xc6196B047901214437D9A4aB99024bc311050Ca1)
- **Built for:** BNB Hack: Tokenized Stocks Edition, main track

![SendStock](assets/botfather-640x360.png)

## How it works

```
Telegram group ──/tip @alice 5 NVDA──▶ Bot (grammY)
                                        │  RWA Data API: ticker → bStock, price, company, market session
                                        ▼
Sender ──Confirm & pay──▶ Mini App (Privy wallet from Telegram login)
                                        │  one tx: TipEscrow.tipWithSwap(USDT → NVDAB via PancakeSwap v3)
                                        ▼
                                  TipEscrow (BSC mainnet) holds the stock
                                        ▲
Recipient ──Claim──▶ Mini App ── server checks Telegram identity ──▶ Binance Agentic Wallet
                                                                     contract-call claim(tipId, wallet)
                                                                     (operator pays the gas)
```

1. **Tip:** the bot resolves the ticker to a bStock with the Binance Web3 **RWA Data API**, prices it, and posts a tip card showing the shares, price and US market session ("US market closed, still a real stock on-chain 24/7").
2. **Pay:** the sender opens the Mini App. The server quotes every PancakeSwap v3 fee tier and builds one `tipWithSwap` transaction. The escrow pulls USDT, swaps through an allow-listed router, checks `minOut` against what it actually received, and holds the stock.
3. **Verify:** the server reads the receipt and only accepts a `Tipped` event from our escrow, for this tip (bound by a per-tip hash), for the right stock and amount. Payments can't be replayed across tips.
4. **Claim:** Telegram's signed `initData` proves who the recipient is. The bot's **Binance Agentic Wallet** (the escrow's operator) calls `claim` through `baw contract-call` preview → execute, so recipients never need gas. A watcher settles claims from on-chain state, which covers Agentic Wallet calls that wait for approval in the Binance App.
5. **Refund:** unclaimed tips can be returned to the sender after 7 days.

## What's in the repo

| Path | What |
|---|---|
| `contracts/` | `TipEscrow.sol` (OpenZeppelin, Hardhat 3), 21 unit tests + a BSC mainnet-fork test (real USDT → NVDAB via PancakeSwap, then claim), deploy script |
| `bot/` | Telegram bot (grammY), Mini App API (Hono), RWA Data API client, Agentic Wallet operator (`baw` CLI) with keep-alive, SQLite store, end-to-end test (`scripts/e2e-local.ts`) |
| `app/` | Telegram Mini App (Vite + React + Privy): Pay, Claim, My tips |

## Binance Web3 / BNB stack used

- **RWA Data API:** bStock list (87 tokens), company profile + proof-of-collateral link, market status, on-chain price and share multiplier.
- **Binance Agentic Wallet** (`baw` 1.10): escrow operator, gasless claims through Developer Mode `contract-call`, session keep-alive.
- **BNB Chain:** BSC mainnet, bStocks, PancakeSwap v3 (best fee tier picked per tip).

## Run it

Requirements: Node 22.13+ (built-in `node:sqlite`), a Telegram bot token, a Privy app (Telegram login + seamless auth, Ethereum embedded wallets on login), and an Agentic Wallet signed in with Developer Mode on.

```bash
npm install
cp .env.example .env          # fill in TELEGRAM_BOT_TOKEN, VITE_PRIVY_APP_ID, ESCROW_ADDRESS, OPERATOR_ADDRESS
cd contracts && npx hardhat test solidity     # unit + mainnet-fork tests
cd ../bot && npm start                        # bot + API on :8787
cd ../app && npm run dev                      # Mini App on :5173 (?mock=pay|claim|list previews without Telegram)
```

Deploy your own escrow with `cd contracts && npx tsx --env-file=../.env scripts/deploy.ts` (dry run), then add `--yes`.

## Trust model and limits

- The escrow **operator** (the Agentic Wallet) decides who may claim a tip, based on Telegram's signed login checked by the server. The owner can replace the operator. Senders can always recover unclaimed tips after expiry.
- Spot only: tips are swaps into bStocks. No leverage, no perps.
- Agentic Wallet Developer Mode expires after 7 days and must be turned back on in the Binance App. The bot logs a warning when that happens.

## Next steps

- Link email to the Telegram account as a wallet backup.
- Pay from an existing wallet (Binance Web3 Wallet / MetaMask via WalletConnect).
- Group "tip jar" run by the Agentic Wallet (`baw market-order swap` + `tip`).
- Route swaps through the Binance Trading API aggregator.
