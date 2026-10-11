import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Store } from "./db.ts";
import type { Chain } from "./chain.ts";
import type { Operator } from "./operator.ts";
import type { RwaClient } from "./rwa.ts";
import { verifyInitData, type MiniAppUser } from "./telegram-auth.ts";
import { publicTip, TipService, UserError } from "./service.ts";

type Env = { Variables: { user: MiniAppUser } };

export function createApi(opts: {
  botToken: string;
  store: Store;
  /** Absent until TipEscrow is deployed: viewing works, paying and claiming say "not live yet". */
  payments?: { chain: Chain; operator: Operator; service: TipService };
  rwa?: RwaClient;
  /** Extra origins allowed to call the API (e.g. the Vite dev server). */
  corsOrigins?: string[];
}) {
  const { store, payments } = opts;
  const service = () => {
    if (!payments) throw new UserError("Payments aren't switched on yet. Please try again a bit later.", 503);
    return payments.service;
  };
  const app = new Hono<Env>();

  if (opts.corsOrigins?.length) app.use("/api/*", cors({ origin: opts.corsOrigins }));

  app.get("/api/health", (c) => c.json({ ok: true }));

  /** Public config the Mini App needs before login. */
  app.get("/api/config", (c) =>
    c.json({
      chainId: 56,
      paymentsLive: !!payments,
      escrow: payments?.chain.escrow ?? null,
      operator: payments ? { kind: payments.operator.kind, address: payments.operator.address } : null,
    }),
  );

  // Every other route needs Telegram Mini App initData: "Authorization: tma <initData>".
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const initData = header.startsWith("tma ") ? header.slice(4) : "";
    const verified = initData ? verifyInitData(initData, opts.botToken) : null;
    if (!verified) return c.json({ error: "Open this from Telegram." }, 401);
    c.set("user", verified.user);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, err.status);
    console.error(`${c.req.method} ${c.req.path}`, err);
    return c.json({ error: "Something went wrong. Please try again." }, 500);
  });

  const body = async (c: { req: { json: () => Promise<unknown> } }) =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  app.get("/api/tips/:id", (c) => {
    const tip = store.tip(c.req.param("id"));
    if (!tip) throw new UserError("Tip not found.", 404);
    return c.json(publicTip(tip, c.get("user")));
  });

  /** Company card and live value for the stock in a tip (RWA Data API). */
  app.get("/api/tips/:id/stock", async (c) => {
    const tip = store.tip(c.req.param("id"));
    if (!tip) throw new UserError("Tip not found.", 404);
    if (!opts.rwa) throw new UserError("Stock data is unavailable.", 409);
    const stock = await opts.rwa.resolve(tip.symbol);
    if (!stock) throw new UserError("Stock data is unavailable.", 409);
    const [meta, quote, market] = await Promise.allSettled([opts.rwa.meta(stock), opts.rwa.quote(stock), opts.rwa.marketStatus()]);
    const tokens = tip.token_amount ? Number(tip.token_amount) / 1e18 : tip.amount_usd / tip.token_price;
    return c.json({
      meta: meta.status === "fulfilled" ? meta.value : null,
      tokenPrice: quote.status === "fulfilled" ? quote.value.tokenPrice : null,
      sharePrice: quote.status === "fulfilled" ? quote.value.sharePrice : null,
      changePct24h: quote.status === "fulfilled" ? quote.value.changePct24h : null,
      valueNowUsd: quote.status === "fulfilled" ? tokens * quote.value.tokenPrice : null,
      tokens,
      market: market.status === "fulfilled" ? market.value : null,
    });
  });

  app.post("/api/tips/:id/plan", async (c) => {
    const { wallet } = await body(c);
    return c.json(await service().planPayment(c.req.param("id"), c.get("user"), wallet));
  });

  app.post("/api/tips/:id/paid", async (c) => {
    const { txHash } = await body(c);
    const tip = await service().confirmPayment(c.req.param("id"), c.get("user"), txHash);
    return c.json(publicTip(tip, c.get("user")));
  });

  app.post("/api/tips/:id/claim", async (c) => {
    const { wallet } = await body(c);
    const tip = await service().claim(c.req.param("id"), c.get("user"), wallet);
    return c.json(publicTip(tip, c.get("user")));
  });

  app.get("/api/me/tips", (c) => {
    const user = c.get("user");
    return c.json(store.tipsForUser(user.id, user.username).map((t) => publicTip(t, user)));
  });

  return app;
}
