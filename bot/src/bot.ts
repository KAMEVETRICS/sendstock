import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import type { User } from "grammy/types";
import type { Config } from "./config.ts";
import type { Store, TipRow } from "./db.ts";
import type { RwaClient } from "./rwa.ts";
import { cancelledCard, claimedCard, escrowedCard, pendingCard } from "./card.ts";
import { parseTipArgs } from "./parse.ts";

export function displayName(u: Pick<User, "first_name" | "last_name">): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ");
}

interface Recipient {
  tgId: number | null;
  username: string | null;
  name: string;
}

/** Works out who is being tipped: a replied-to message, a text mention, or an @username. */
function findRecipient(ctx: Context, mention: string | null, store: Store): Recipient | null {
  const reply = ctx.message?.reply_to_message?.from;
  if (reply && !mention) {
    return { tgId: reply.id, username: reply.username ?? null, name: displayName(reply) };
  }
  const textMention = ctx.entities("text_mention")[0];
  if (textMention?.type === "text_mention") {
    const u = textMention.user;
    return { tgId: u.id, username: u.username ?? null, name: displayName(u) };
  }
  if (mention) {
    const known = store.userByUsername(mention);
    return { tgId: known?.tg_id ?? null, username: mention, name: known?.name ?? `@${mention}` };
  }
  return null;
}

export function createBot(config: Config, store: Store, rwa: RwaClient) {
  const bot = new Bot(config.telegramToken);

  const miniAppLink = (param: string) =>
    `https://t.me/${bot.botInfo.username}/${config.miniAppShortName}?startapp=${param}`;

  function keyboardFor(tip: TipRow): InlineKeyboard | undefined {
    switch (tip.status) {
      case "awaiting_payment":
        return new InlineKeyboard()
          .url(`Confirm & pay $${tip.amount_usd.toFixed(2)}`, miniAppLink(`pay_${tip.id}`))
          .text("Cancel", `cancel:${tip.id}`);
      case "escrowed":
        return new InlineKeyboard().url("🎁 Claim", miniAppLink(`claim_${tip.id}`));
      default:
        return undefined;
    }
  }

  /** Re-renders a tip's group message after its status changes (payment, claim, expiry). */
  async function refreshCard(tipId: string, reason?: string): Promise<void> {
    const tip = store.tip(tipId);
    if (!tip?.message_id) return;
    const text =
      tip.status === "escrowed" ? escrowedCard(tip)
      : tip.status === "claimed" ? claimedCard(tip)
      : tip.status === "cancelled" || tip.status === "refunded" ? cancelledCard(tip, reason)
      : null;
    if (!text) return;
    try {
      await bot.api.editMessageText(tip.chat_id, tip.message_id, text, {
        parse_mode: "HTML",
        reply_markup: keyboardFor(tip),
      });
    } catch (e) {
      if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
      throw e;
    }
  }

  // Remember everyone who speaks, so "@username" tips can be matched to a Telegram id.
  // Needs privacy mode off (@BotFather → /setprivacy → Disable) to see non-command messages.
  bot.on("message", async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) store.seeUser(ctx.from.id, ctx.from.username, displayName(ctx.from));
    const replied = ctx.message.reply_to_message?.from;
    if (replied && !replied.is_bot) store.seeUser(replied.id, replied.username, displayName(replied));
    await next();
  });

  bot.command(["start", "help"], (ctx) =>
    ctx.reply(
      [
        "🎁 <b>SendStock</b>: tip friends real US stocks on BNB Chain.",
        "",
        "In a group:",
        "• <code>/tip @alice 5 NVDA</code>",
        "• or reply to a message with <code>/tip 5 TSLA</code>",
        "",
        `Tips are $${config.minTipUsd}–$${config.maxTipUsd}. The recipient claims with one tap: no seed phrase, no gas.`,
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  bot.command("tip", async (ctx) => {
    if (ctx.chat.type === "private") {
      return ctx.reply("Tips happen in groups. Add me to a group and use /tip @friend 5 NVDA there.");
    }
    const sender = ctx.from;
    if (!sender) return;

    const parsed = parseTipArgs(ctx.match, { min: config.minTipUsd, max: config.maxTipUsd });
    if (!parsed.ok) return ctx.reply(parsed.error, { reply_parameters: { message_id: ctx.msgId } });
    const { amountUsd, ticker, mention } = parsed.args;

    const recipient = findRecipient(ctx, mention, store);
    if (!recipient) {
      return ctx.reply("Who's it for? Use /tip @user 5 NVDA, or reply to their message with /tip 5 NVDA.", {
        reply_parameters: { message_id: ctx.msgId },
      });
    }
    const sameUsername =
      !!recipient.username && !!sender.username && recipient.username.toLowerCase() === sender.username.toLowerCase();
    if (recipient.tgId === sender.id || sameUsername) {
      return ctx.reply("You can't tip yourself 🙂", { reply_parameters: { message_id: ctx.msgId } });
    }
    if (recipient.username?.toLowerCase() === bot.botInfo.username.toLowerCase()) {
      return ctx.reply("Thanks, but I can't hold stocks 🙂", { reply_parameters: { message_id: ctx.msgId } });
    }

    const stock = await rwa.resolve(ticker);
    if (!stock) {
      return ctx.reply(`I couldn't find a tokenized ${ticker} on BNB Chain. Try NVDA, TSLA, AAPL, SPY or MSFT.`, {
        reply_parameters: { message_id: ctx.msgId },
      });
    }

    const [quote, meta, market] = await Promise.allSettled([rwa.quote(stock), rwa.meta(stock), rwa.marketStatus()]);
    if (quote.status === "rejected") {
      console.error("quote failed", quote.reason);
      return ctx.reply(`I couldn't get a price for ${stock.ticker} right now. Try again in a minute.`);
    }
    if (!quote.value.tradable) {
      const why = quote.value.statusReason ? ` (${quote.value.statusReason})` : "";
      return ctx.reply(`${stock.ticker} is paused right now${why}, so I can't send it. Try another stock.`);
    }

    const tip = store.createTip({
      chatId: ctx.chat.id,
      senderTgId: sender.id,
      senderName: displayName(sender),
      recipientTgId: recipient.tgId,
      recipientUsername: recipient.username,
      recipientName: recipient.name,
      ticker: stock.ticker,
      symbol: stock.symbol,
      tokenAddress: stock.address,
      amountUsd,
      sharePrice: quote.value.sharePrice,
      tokenPrice: quote.value.tokenPrice,
      companyName: meta.status === "fulfilled" ? meta.value.companyName : stock.ticker,
    });

    const sent = await ctx.reply(
      pendingCard(tip, market.status === "fulfilled" ? market.value : null, config.payWindowMinutes),
      { parse_mode: "HTML", reply_markup: keyboardFor(tip), reply_parameters: { message_id: ctx.msgId } },
    );
    store.setMessageId(tip.id, sent.message_id);
  });

  bot.callbackQuery(/^cancel:([A-Za-z0-9]+)$/, async (ctx) => {
    const tip = store.tip(ctx.match[1]);
    if (!tip) return ctx.answerCallbackQuery({ text: "That tip no longer exists." });
    if (tip.sender_tg_id !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: "Only the person sending the tip can cancel it.", show_alert: true });
    }
    if (!store.transition(tip.id, "awaiting_payment", "cancelled")) {
      return ctx.answerCallbackQuery({ text: "This tip has already been paid, so it can't be cancelled here." });
    }
    await ctx.answerCallbackQuery({ text: "Tip cancelled." });
    await refreshCard(tip.id);
  });

  bot.catch((err) => console.error(`Error handling update ${err.ctx.update.update_id}:`, err.error));

  /** Cancels tips nobody paid for within the pay window. */
  async function expireStaleTips(): Promise<void> {
    for (const tip of store.stalePending(config.payWindowMinutes * 60_000)) {
      if (store.transition(tip.id, "awaiting_payment", "cancelled")) {
        await refreshCard(tip.id, "Expired: not confirmed in time.").catch((e) => console.error("refreshCard", e));
      }
    }
  }

  return { bot, refreshCard, expireStaleTips, miniAppLink };
}
