// End-to-end test of the Mini App API (pay → verify → claim) on a local chain. Mock USDT, NVDAB and
// PancakeSwap contracts are placed at their real mainnet addresses, so the server code runs unchanged.
// The real-pool path is covered by contracts/contracts/TipEscrowFork.t.sol. No Telegram, no real money.
//
//   cd contracts && npx hardhat build && npx hardhat node --chain-id 56
//   cd bot && npx tsx scripts/e2e-local.ts

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  createTestClient, createWalletClient, formatUnits, http, parseAbi, parseUnits, publicActions,
  type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { Store } from "../src/db.ts";
import { Chain, PCS_V3_QUOTER, PCS_V3_ROUTER, USDT } from "../src/chain.ts";
import { KeyOperator } from "../src/operator.ts";
import { TipService } from "../src/service.ts";
import { createApi } from "../src/api.ts";
import { signInitData } from "../src/telegram-auth.ts";

const RPC = "http://127.0.0.1:8545";
const NVDAB: Address = "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436";
const BOT_TOKEN = "123456:e2e-test-token";
// Hardhat's well-known dev keys. Never use these anywhere real.
const OWNER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OPERATOR_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SENDER_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function mint(address to, uint256 amount)"]);
const test = createTestClient({ mode: "hardhat", chain: bsc, transport: http(RPC) }).extend(publicActions);
const walletFor = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: bsc, transport: http(RPC) });

const artifact = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../contracts/artifacts/contracts/${path}`, import.meta.url), "utf8"));

/** Puts mock contracts at the real mainnet addresses the server code uses. */
async function installMocks() {
  const token = artifact("mocks/Mocks.sol/MockERC20.json").deployedBytecode;
  await test.setCode({ address: USDT, bytecode: token });
  await test.setCode({ address: NVDAB, bytecode: token });
  await test.setCode({ address: PCS_V3_QUOTER, bytecode: artifact("mocks/MockPancake.sol/MockQuoterV2.json").deployedBytecode });
  await test.setCode({ address: PCS_V3_ROUTER, bytecode: artifact("mocks/MockPancake.sol/MockSwapRouter.json").deployedBytecode });
}

function initData(user: { id: number; first_name: string; username?: string }) {
  return signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) }, BOT_TOKEN);
}

let step = 0;
const ok = (msg: string) => console.log(`  ✔ ${++step}. ${msg}`);

async function main() {
  await installMocks();
  ok("mock USDT, NVDAB and PancakeSwap v3 installed at their mainnet addresses (1 NVDAB = 200 USDT)");
  const owner = walletFor(OWNER_KEY);
  const sender = walletFor(SENDER_KEY);
  const operatorAccount = privateKeyToAccount(OPERATOR_KEY);
  const recipientWallet = privateKeyToAccount(generatePrivateKey()).address; // brand-new, holds nothing

  // Deploy TipEscrow and allow the PancakeSwap v3 router.
  const escrowArtifact = artifact("TipEscrow.sol/TipEscrow.json");
  const deployTx = await owner.deployContract({
    abi: escrowArtifact.abi, bytecode: escrowArtifact.bytecode, args: [owner.account.address, operatorAccount.address],
  });
  const escrow = (await test.waitForTransactionReceipt({ hash: deployTx })).contractAddress!;
  await test.waitForTransactionReceipt({
    hash: await owner.writeContract({ address: escrow, abi: escrowArtifact.abi, functionName: "setRouter", args: [PCS_V3_ROUTER, true] }),
  });
  ok(`TipEscrow deployed at ${escrow}`);

  await test.waitForTransactionReceipt({
    hash: await owner.writeContract({ address: USDT, abi: erc20, functionName: "mint", args: [sender.account.address, parseUnits("20", 18)] }),
  });
  ok("sender funded with 20 USDT");

  // Server side, exactly as main.ts wires it.
  const dir = mkdtempSync(join(tmpdir(), "stocktip-e2e-"));
  const store = new Store(join(dir, "e2e.db"));
  const chain = new Chain(RPC, escrow);
  const operator = new KeyOperator(OPERATOR_KEY, RPC);
  const changed: string[] = [];
  const service = new TipService(store, chain, operator, async (id) => void changed.push(`${id}:${store.tip(id)!.status}`));
  const api = createApi({ botToken: BOT_TOKEN, store, payments: { chain, operator, service } });

  const kay = { id: 1001, first_name: "Kay", username: "kay_s" };
  const alice = { id: 1002, first_name: "Alice", username: "alice_b" };
  const eve = { id: 1003, first_name: "Eve", username: "eve_x" };
  const call = async (user: typeof kay, path: string, body?: object) => {
    const res = await api.request(path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `tma ${initData(user)}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  // Price the card the way the bot would (from a $5 quote).
  const { out } = await chain.bestQuote(NVDAB, parseUnits("5", 18));
  const tokenPrice = 5 / Number(formatUnits(out, 18));
  const newTip = () =>
    store.createTip({
      chatId: -100, senderTgId: kay.id, senderName: "Kay", recipientTgId: null, recipientUsername: "alice_b",
      recipientName: "@alice_b", ticker: "NVDA", symbol: "NVDAB", tokenAddress: NVDAB, amountUsd: 5,
      sharePrice: tokenPrice, tokenPrice, companyName: "Nvidia Corp",
    });
  const tip = newTip();
  ok(`tip ${tip.id} created: $5 of NVDA for @alice_b (≈ $${tokenPrice.toFixed(2)}/token)`);

  // Auth and roles.
  assert.equal((await api.request(`/api/tips/${tip.id}`)).status, 401);
  assert.equal((await call(alice, `/api/tips/${tip.id}`)).json.role, "recipient");
  assert.equal((await call(eve, `/api/tips/${tip.id}`)).json.role, "viewer");
  assert.equal((await call(alice, `/api/tips/${tip.id}/plan`, { wallet: recipientWallet })).status, 403);
  ok("no initData → 401; Alice is recipient, Eve is viewer; only the sender can get a payment plan");

  // Pay.
  const plan = (await call(kay, `/api/tips/${tip.id}/plan`, { wallet: sender.account.address })).json;
  assert.equal(plan.enoughBalance, true);
  assert.ok(plan.approveTx, "first tip needs an approval");
  ok(`plan: ${plan.amountIn} USDT → ≈${plan.expectedOut} NVDAB via the ${plan.poolFeeBps / 100}% pool (min ${plan.minOut})`);

  const usdtBefore = await test.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [sender.account.address] });
  await test.waitForTransactionReceipt({ hash: await sender.sendTransaction(plan.approveTx) });
  const payTx = await sender.sendTransaction(plan.tipTx);
  await test.waitForTransactionReceipt({ hash: payTx });
  const paid = await call(kay, `/api/tips/${tip.id}/paid`, { txHash: payTx });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  assert.equal(paid.json.status, "escrowed");
  assert.equal(await test.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [sender.account.address] }), usdtBefore - parseUnits("5", 18));
  ok(`payment verified on-chain: ${formatUnits(BigInt(paid.json.tokenAmount), 18)} NVDAB escrowed, sender down exactly 5 USDT`);

  assert.equal((await call(kay, `/api/tips/${tip.id}/paid`, { txHash: payTx })).json.status, "escrowed");
  const other = newTip();
  const replay = await call(kay, `/api/tips/${other.id}/paid`, { txHash: payTx });
  assert.equal(replay.status, 400);
  ok(`confirming twice is harmless; replaying the tx for another tip is rejected ("${replay.json.error}")`);

  // Claim.
  assert.equal((await call(eve, `/api/tips/${tip.id}/claim`, { wallet: eve.username })).status, 403);
  const claimed = await call(alice, `/api/tips/${tip.id}/claim`, { wallet: recipientWallet });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
  assert.equal(claimed.json.status, "claimed");
  const got = await test.readContract({ address: NVDAB, abi: erc20, functionName: "balanceOf", args: [recipientWallet] });
  assert.equal(got.toString(), paid.json.tokenAmount);
  ok(`Eve can't claim; Alice claimed to a fresh wallet, gas paid by the operator. Wallet holds ${formatUnits(got, 18)} NVDAB`);

  assert.equal((await call(alice, `/api/tips/${tip.id}/claim`, { wallet: recipientWallet })).json.status, "claimed");
  assert.equal(store.tip(tip.id)!.recipient_tg_id, alice.id);
  const mine = (await call(alice, "/api/me/tips")).json;
  assert.equal(mine.length, 1);
  ok("second claim is a no-op; Alice's Telegram id is now linked; /api/me/tips lists her tip");

  assert.deepEqual(changed, [`${tip.id}:escrowed`, `${tip.id}:claimed`]);
  ok("group card refreshed twice: escrowed, then claimed");

  store.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`\nAll ${step} steps passed.`);
}

main().catch((e) => {
  console.error("\nE2E FAILED:", e);
  process.exit(1);
});
