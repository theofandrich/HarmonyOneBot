import express from "express";
import {
  Bot,
  Enhance,
  GrammyError,
  HttpError,
  MemorySessionStorage,
  enhanceStorage,
  session,
} from "grammy";
import { autoChatAction } from "@grammyjs/auto-chat-action";
import { limit } from "@grammyjs/ratelimiter";
import { pino } from "pino";

import {
  BotContext,
  BotSessionData,
  OnCallBackQueryData,
  OnMessageContext,
} from "./modules/types";
import { mainMenu } from "./pages";
import { VoiceMemo } from "./modules/voice-memo";
import { QRCodeBot } from "./modules/qrcode/QRCodeBot";
import { SDImagesBot } from "./modules/sd-images";
import { OpenAIBot } from "./modules/open-ai";
import { OneCountryBot } from "./modules/1country";
import { WalletConnect } from "./modules/walletconnect";
import { BotPayments } from "./modules/payment";
import { BotSchedule } from "./modules/schedule";
import config from "./config";
import { commandsHelpText, TERMS, SUPPORT, FEEDBACK, LOVE } from "./constants";

import {chatService} from "./database/services";
import {AppDataSource} from "./database/datasource";
import { text } from "stream/consumers";
import { autoRetry } from "@grammyjs/auto-retry";


const logger = pino({
  name: "bot",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
});

export const bot = new Bot<BotContext>(config.telegramBotAuthToken);
bot.api.config.use(autoRetry());

bot.use(
  limit({
    // Allow only 3 message to be handled every 3 seconds.
    timeFrame: 3000,
    limit: 3,

    // This is called when the limit is exceeded.
    onLimitExceeded: async (ctx) => {
      // await ctx.reply("Please refrain from sending too many requests")
      logger.error(`@${ctx.from?.username} has exceeded the message limit`);
      // await ctx.reply("");
    },

    // Note that the key should be a number in string format such as "123456789".
    keyGenerator: (ctx) => {
      return ctx.from?.id.toString();
    },
  })
);

function createInitialSessionData(): BotSessionData {
  return {
    openAi: {
      imageGen: {
        numImages: config.openAi.dalle.sessionDefault.numImages,
        imgSize: config.openAi.dalle.sessionDefault.imgSize,
        isEnabled: config.openAi.dalle.isEnabled,
      },
      chatGpt: {
        model: config.openAi.chatGpt.model,
        isEnabled: config.openAi.chatGpt.isEnabled,
        chatConversation: [],
        price: 0,
        usage: 0,
      },
    },
    oneCountry: {
      lastDomain: "",
    },
  };
}

bot.use(
  session({
    initial: createInitialSessionData,
    storage: enhanceStorage<BotSessionData>({
      storage: new MemorySessionStorage<Enhance<BotSessionData>>(),
      millisecondsToLive: config.sessionTimeout * 60 * 60 * 1000, //48 hours
    }),
  })
);
bot.use(autoChatAction());
bot.use(mainMenu);

const voiceMemo = new VoiceMemo();
const qrCodeBot = new QRCodeBot();
const sdImagesBot = new SDImagesBot();
const walletConnect = new WalletConnect();
const payments = new BotPayments();
const schedule = new BotSchedule(bot);
const openAiBot = new OpenAIBot(payments);
const oneCountryBot = new OneCountryBot();

bot.on("message:new_chat_members:me", (ctx) => {
  const createChat = async () => {
    const accountId = payments.getAccountId(ctx as OnMessageContext);

    const chat = await chatService.getAccountById(accountId);

    if (chat) {
      return;
    }

    const tgUserId = ctx.message.from.id;
    const tgUsername = ctx.message.from.username || "";

    await chatService.initChat({ tgUserId, accountId, tgUsername });
  };

  createChat();
});

const assignFreeCredits = async (ctx: OnMessageContext) => {
  const { chat } = ctx.update.message;

  const accountId = payments.getAccountId(ctx as OnMessageContext);
  let tgUserId = accountId;
  let tgUsername = "";

  const isCreditsAssigned = await chatService.isCreditsAssigned(accountId);
  if (isCreditsAssigned) {
    return true;
  }

  try {
    if (chat.type === "group") {
      const members = await ctx.getChatAdministrators();
      const creator = members.find((member) => member.status === "creator");
      if (creator) {
        tgUserId = creator.user.id;
        tgUsername = creator.user.username || "";
      }
    }

    await chatService.initChat({ accountId, tgUserId, tgUsername });
    // logger.info(`credits transferred to accountId ${accountId} chat ${chat.type} ${chat.id}`)
  } catch (e) {
    logger.error(
      `Cannot check account ${accountId} credits: ${(e as Error).message}`
    );
  }
  return true;
};

const onMessage = async (ctx: OnMessageContext) => {
  await assignFreeCredits(ctx);

  if (qrCodeBot.isSupportedEvent(ctx)) {
    const price = qrCodeBot.getEstimatedPrice(ctx);
    const isPaid = await payments.pay(ctx, price);
    if (isPaid) {
      qrCodeBot
        .onEvent(ctx, (reason?: string) => {
          payments.refundPayment(reason, ctx, price);
        })
        .catch((e) => {
          payments.refundPayment(e.message || "Unknown error", ctx, price);
        });

      return;
    }
  }
  if (sdImagesBot.isSupportedEvent(ctx)) {
    const price = sdImagesBot.getEstimatedPrice(ctx);
    const isPaid = await payments.pay(ctx, price);
    if (isPaid) {
      sdImagesBot
        .onEvent(ctx, (reason?: string) => {
          payments.refundPayment(reason, ctx, price);
        })
        .catch((e) => {
          payments.refundPayment(e.message || "Unknown error", ctx, price);
        });
      return;
    }
    return;
  }
  if (voiceMemo.isSupportedEvent(ctx)) {
    const price = voiceMemo.getEstimatedPrice(ctx);
    const isPaid = await payments.pay(ctx, price);
    if (isPaid) {
      voiceMemo.onEvent(ctx).catch((e) => {
        payments.refundPayment(e.message || "Unknown error", ctx, price);
      });
    }
    return;
  }
  if (openAiBot.isSupportedEvent(ctx)) {
    if (ctx.session.openAi.imageGen.isEnabled) {
      if (openAiBot.isValidCommand(ctx)) {
        const price = openAiBot.getEstimatedPrice(ctx);
        const isPaid = await payments.pay(ctx, price);
        if (isPaid) {
          return openAiBot
            .onEvent(ctx)
            .catch((e) => payments.refundPayment(e, ctx, price));
        }
        return;
      } else {
        // ctx.reply("Error: Missing prompt");
        return;
      }
    } else {
      ctx.reply("Bot disabled");
      return;
    }
  }
  if (oneCountryBot.isSupportedEvent(ctx)) {
    if (oneCountryBot.isValidCommand(ctx)) {
      const price = oneCountryBot.getEstimatedPrice(ctx);
      // if (price > 0) {
      //   await ctx.reply(`Processing withdraw for ${price.toFixed(2)}¢...`);
      // }
      const isPaid = await payments.pay(ctx, price);
      if (isPaid) {
        oneCountryBot
          .onEvent(ctx)
          .catch((e) => payments.refundPayment(e, ctx, price));
        return;
      }
      return;
    } else {
      // ctx.reply("Error: Missing prompt");
      return;
    }
  }

  if (walletConnect.isSupportedEvent(ctx)) {
    walletConnect.onEvent(ctx);
    return;
  }
  if (payments.isSupportedEvent(ctx)) {
    payments.onEvent(ctx);
    return;
  }
  if (schedule.isSupportedEvent(ctx)) {
    schedule.onEvent(ctx);
    return;
  }
  // if (ctx.update.message.text && ctx.update.message.text.startsWith("/", 0)) {
  //  const command = ctx.update.message.text.split(' ')[0].slice(1)
  // onlfy for private chats
  if (ctx.update.message.chat && ctx.chat.type === "private") {
    ctx.reply(
      `Unsupported, type */help* for commands.`,
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }
  if (ctx.update.message.chat) {
    logger.info(`Received message in chat id: ${ctx.update.message.chat.id}`);
  }
};

const onCallback = async (ctx: OnCallBackQueryData) => {
  if (qrCodeBot.isSupportedEvent(ctx)) {
    qrCodeBot.onEvent(ctx, (reason) => {
      logger.error(`qr generate error: ${reason}`);
    });
    return;
  }

  if (sdImagesBot.isSupportedEvent(ctx)) {
    sdImagesBot.onEvent(ctx, (e) => {
      console.log(e, "// TODO refund payment");
    });
    return;
  }
};

bot.command(["start", "help", "menu"], async (ctx) => {
  const accountId = payments.getAccountId(ctx as OnMessageContext);
  const account = payments.getUserAccount(accountId);

  await assignFreeCredits(ctx as OnMessageContext);

  if (!account) {
    return false;
  }

  const addressBalance = await payments.getAddressBalance(account.address);
  const credits = await chatService.getBalance(accountId);
  const balance = addressBalance.plus(credits);
  const balanceOne = payments.toONE(balance, false).toFixed(2);
  const startText = commandsHelpText.start
    .replaceAll("$CREDITS", balanceOne + "")
    .replaceAll("$WALLET_ADDRESS", account.address);

  await ctx.reply(startText, {
    parse_mode: "Markdown",
    reply_markup: mainMenu,
    disable_web_page_preview: true,
  });
});

bot.command("more", async (ctx) => {
  ctx.reply(commandsHelpText.more, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
});

bot.command("terms", (ctx) => {
  ctx.reply(TERMS.text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
});

bot.command("support", (ctx) => {
  ctx.reply(SUPPORT.text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
});

bot.command("feedback", (ctx) => {
  ctx.reply(FEEDBACK.text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
});

bot.command("love", (ctx) => {
  ctx.reply(LOVE.text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
});

// bot.command("memo", (ctx) => {
//   ctx.reply(MEMO.text, {
//     parse_mode: "Markdown",
//     disable_web_page_preview: true,
//   });
// });

// bot.command("menu", async (ctx) => {
//   await ctx.reply(menuText.mainMenu.helpText, {
//     parse_mode: "Markdown",
//     reply_markup: mainMenu,
//   });
// });

bot.on("message", onMessage);
bot.on("callback_query:data", onCallback);

bot.catch((err) => {
  const ctx = err.ctx;
  logger.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.log('Grammy error:', {e});
    logger.error("Error in request:", e.description);
    logger.error(`Error in message: ${JSON.stringify(ctx.message)}`)
  } else if (e instanceof HttpError) {
    logger.error("Could not contact Telegram:", e);
  } else {
    logger.error("Unknown error:", e);
  }
});

bot.errorBoundary((error) => {
  logger.error("### error", error);
});

const app = express();

app.use(express.json());
app.use(express.static("./public")); // Public directory, used in voice-memo bot

app.listen(config.port, () => {
  logger.info(`Bot listening on port ${config.port}`);
  bot.start({
    drop_pending_updates: true
  });

  AppDataSource.initialize();
  // bot.start({
  //   allowed_updates: ["callback_query"], // Needs to be set for menu middleware, but bot doesn't work with current configuration.
  // });
});
