// Deploys TipEscrow to BSC mainnet and allow-lists the PancakeSwap v3 router.
//
//   npx tsx --env-file=../.env scripts/deploy.ts          # dry run: addresses, balances, cost estimate
//   npx tsx --env-file=../.env scripts/deploy.ts --yes    # actually deploy
//
// Owner = the deployer wallet (can replace the operator / routers later).
// Operator = OPERATOR_ADDRESS (the Agentic Wallet), the only address allowed to release tips.

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeDeployData, formatEther, formatUnits, getAddress, http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

const PCS_V3_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const RPC = process.env.RPC_URL || "https://bsc-dataseed.bnbchain.org";

const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
const operatorRaw = process.env.OPERATOR_ADDRESS;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("DEPLOYER_PRIVATE_KEY missing or not a 0x-prefixed 32-byte hex key");
if (!operatorRaw || !isAddress(operatorRaw)) throw new Error("OPERATOR_ADDRESS missing or invalid");
const operator = getAddress(operatorRaw);

const artifact = JSON.parse(readFileSync(new URL("../artifacts/contracts/TipEscrow.sol/TipEscrow.json", import.meta.url), "utf8"));
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: bsc, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC) });

const [balance, gasPrice, deployGas] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.getGasPrice(),
  pub.estimateGas({
    account: account.address,
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [account.address, operator] }),
  }),
]);
const totalGas = deployGas + 60_000n; // + setRouter
const cost = totalGas * gasPrice;

console.log(`Deployer (owner): ${account.address}  balance ${formatEther(balance)} BNB`);
console.log(`Operator:         ${operator}`);
console.log(`Router allowed:   ${PCS_V3_ROUTER} (PancakeSwap v3)`);
console.log(`Estimated cost:   ~${formatEther(cost)} BNB (${totalGas} gas at ${formatUnits(gasPrice, 9)} gwei)`);

if (balance < cost) throw new Error("Deployer balance is below the estimated cost. Add BNB first.");
if (!process.argv.includes("--yes")) {
  console.log("\nDry run only. Re-run with --yes to deploy.");
  process.exit(0);
}

const deployHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [account.address, operator] });
console.log(`\nDeploy tx: https://bscscan.com/tx/${deployHash}`);
const receipt = await pub.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deploy failed");
const escrow = receipt.contractAddress;
console.log(`TipEscrow:  ${escrow}`);

const routerHash = await wallet.writeContract({ address: escrow, abi: artifact.abi, functionName: "setRouter", args: [PCS_V3_ROUTER, true] });
const r2 = await pub.waitForTransactionReceipt({ hash: routerHash, timeout: 120_000 });
if (r2.status !== "success") throw new Error("setRouter failed");
console.log(`setRouter:  https://bscscan.com/tx/${routerHash}`);

const [onchainOperator, routerOk] = await Promise.all([
  pub.readContract({ address: escrow, abi: artifact.abi, functionName: "operator" }) as Promise<string>,
  pub.readContract({ address: escrow, abi: artifact.abi, functionName: "isRouter", args: [PCS_V3_ROUTER] }) as Promise<boolean>,
]);
console.log(`Check: operator=${onchainOperator}, router allowed=${routerOk}`);
console.log(`\nESCROW_ADDRESS=${escrow}`);
