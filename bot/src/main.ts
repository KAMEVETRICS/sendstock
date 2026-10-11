import { serve } from "@hono/node-server";
import { config } from "./config.ts";
import { useDnsServers } from "./net.ts";
import { Store } from "./db.ts";
import { RwaClient } from "./rwa.ts";
import { createBot } from "./bot.ts";
import { Chain, escrowAbi } from "./chain.ts";
import { AgenticWalletOperator, KeyOperator, type Operator } from "./operator.ts";
import { TipService } from "./service.ts";
import { createApi } from "./api.ts";
import type { TipService as Service } from "./service.ts";

useDnsServers(config.dnsServers);

const store = new Store(config.dbPath);
const rwa = new RwaClient();
const { bot, refreshCard, expireStaleTips } = createBot(config, store, rwa);

await bot.api.setMyCommands([
  { command: "send", description: "Send a friend a US stock privately: /send 5 NVDA" },
  { command: "tip", description: "Tip someone in a group: /tip @user 5 NVDA" },
  { command: "help", description: "How SendStock works" },
]);

const timers: NodeJS.Timeout[] = [
  setInterval(() => expireStaleTips().catch((e) => console.error("expire sweeper", e)), 60_000),
];

function makeOperator(): Operator {
  if (config.operatorKind === "private-key") {
    if (!config.operatorPrivateKey) throw new Error("OPERATOR=private-key needs OPERATOR_PRIVATE_KEY");
    return new KeyOperator(config.operatorPrivateKey, config.rpcUrl);
  }
  if (!config.operatorAddress) throw new Error("OPERATOR=agentic-wallet needs OPERATOR_ADDRESS (run: baw wallet address)");
  return new AgenticWalletOperator(config.operatorAddress);
}

let payments: { chain: Chain; operator: Operator; service: Service } | undefined;
if (config.escrowAddress) {
  const chain = new Chain(config.rpcUrl, config.escrowAddress);
  const operator = makeOperator();
  const onchainOperator = await chain.client.readContract({
    address: chain.escrow,
    abi: escrowAbi,
    functionName: "operator",
  });
  if (onchainOperator.toLowerCase() !== operator.address.toLowerCase()) {
    console.warn(`⚠ Escrow operator is ${onchainOperator}, but this server signs as ${operator.address}. Claims will fail.`);
  }

  if (operator instanceof AgenticWalletOperator) {
    const ping = async () => {
      const s = await operator.keepAlive();
      if (!s.connected) console.error("⚠ Agentic Wallet is signed out: claims will fail until someone signs in again (baw auth signin).");
      else if (!s.devModeUntil) console.error("⚠ Agentic Wallet Developer Mode is off: claims will fail. Turn it on in the Binance App.");
      else console.log(`Agentic Wallet connected; Developer Mode until ${s.devModeUntil}`);
    };
    await ping().catch((e) => console.error("agentic wallet keep-alive", e));
    timers.push(setInterval(() => ping().catch((e) => console.error("agentic wallet keep-alive", e)), 6 * 3600_000));
  }

  const service = new TipService(store, chain, operator, (id) => refreshCard(id));
  payments = { chain, operator, service };
  timers.push(setInterval(() => service.settleClaims().catch((e) => console.error("claim watcher", e)), 15_000));
} else {
  console.log("ESCROW_ADDRESS not set: Mini App can view tips, but paying and claiming are off.");
}

const api = createApi({ botToken: config.telegramToken, store, payments, rwa, corsOrigins: config.corsOrigins });
const server = serve({ fetch: api.fetch, port: config.apiPort }, (info) =>
  console.log(
    `Mini App API on :${info.port}` +
      (payments ? ` (escrow ${payments.chain.escrow}, operator ${payments.operator.kind} ${payments.operator.address})` : " (payments off)"),
  ),
);

async function shutdown() {
  timers.forEach(clearInterval);
  server.close();
  await bot.stop();
  store.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await bot.start({
  allowed_updates: ["message", "callback_query"],
  onStart: (me) => console.log(`SendStock bot running as @${me.username}`),
});
