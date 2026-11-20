import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { Clock } from "./clock";
import { aiConfig, parseAllowlist } from "./config";
import { createAiClient, type AiClient } from "./ai/client";
import { handleCallback, handleText, type CaptureDeps } from "./capture";
import { openDb, type Db } from "./db/index";
import { ensureUser, setVariantIdx, type User, type VariantKind } from "./db/users";
import type { AppEnv } from "./env";
import { RetryableError } from "./errors";
import { GREET_POOL, PRIVATE_BOT_TEXT, SOON_POOL, UNSUPPORTED_POOL, pickVariant } from "./texts";

export interface BotDeps {
  clock: Clock;
  rand: () => number;
  aiTimeoutMs?: number; // лише для тестів: таймаут ШІ (за замовчуванням 20 с, НФ-2)
  ai?: AiClient | null; // у тестах — мок; у проді створюється з ANTHROPIC_API_KEY (null — ключа немає)
}

// getMe на кожен холодний старт ізолята — зайвий запит: id бота — це число перед «:» у токені.
function botInfoFor(token: string): UserFromGetMe {
  return {
    id: Number(token.split(":")[0]) || 0,
    is_bot: true,
    first_name: "adhd",
    username: "adhd_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  } as UserFromGetMe;
}

const START_RE = /^\/start(@\w+)?(\s|$)/;
const COMMAND_RE = /^\/\w+(@\w+)?(\s|$)/;

export async function processUpdate(update: Update, env: AppEnv, deps: BotDeps): Promise<void> {
  const token = env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is missing");
  const allowlist = parseAllowlist(env.ALLOWED_TG_IDS);
  if (allowlist === null) console.error("ALLOWED_TG_IDS is empty or invalid: rejecting everyone");
  const db = openDb(env);
  const bot = new Bot(token, { botInfo: botInfoFor(token) });
  const cfg = aiConfig(env);
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const ai = deps.ai !== undefined ? deps.ai : apiKey ? createAiClient(apiKey) : null;
  const captureDeps = (user: User): CaptureDeps => ({
    db,
    user,
    ai,
    clock: deps.clock,
    rand: deps.rand,
    model: cfg.model,
    dailyLimit: cfg.dailyLimit,
    ...(deps.aiTimeoutMs === undefined ? {} : { timeoutMs: deps.aiTimeoutMs }),
  });
  // Збій D1 до того, як щось збережено → 500, і Telegram повторить доставку (S1.4.h).
  const userOrRetry = async (tgId: number): Promise<User> => {
    try {
      return await ensureUser(tgId, db, deps.clock.now());
    } catch (err) {
      throw new RetryableError(err);
    }
  };

  // Не-текстові update-и й edited_message у Фазі 0 ігноруємо повністю: без відповіді й без запису (0.7.c).
  // Не-приватний чат — теж тиша, до перевірки allowlist: відповідь у групі бачать усі (0.6.d).
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    const fromId = ctx.from?.id;
    if (fromId === undefined || allowlist === null || !allowlist.has(fromId)) {
      await ctx.reply(PRIVATE_BOT_TEXT);
      return;
    }
    const user = await userOrRetry(fromId);
    const text = ctx.message.text;
    if (START_RE.test(text)) {
      await ctx.reply(await nextVariant(user, "greet", GREET_POOL, deps, db));
    } else if (COMMAND_RE.test(text)) {
      // Команди (/today, /foo…) — не захоплення: без запису й без ШІ (S1.4.f).
      await ctx.reply(await nextVariant(user, "soon", SOON_POOL, deps, db));
    } else {
      await handleText(ctx, captureDeps(user));
    }
  });

  // Фото, стікер тощо: коротка відповідь, нічого не зберігається (S1.4.i). Голос і пересилання — крок 1.4:
  // до нього вони ігноруються, як і раніше.
  bot.on("message", async (ctx) => {
    if (ctx.chat.type !== "private" || ctx.message.voice || ctx.message.forward_origin) return;
    const fromId = ctx.from?.id;
    if (fromId === undefined || allowlist === null || !allowlist.has(fromId)) return;
    await ctx.reply(UNSUPPORTED_POOL[pickVariant(UNSUPPORTED_POOL.length, null, deps.rand)] ?? "");
  });

  // Кожен callback отримує відповідь у будь-якому разі (НФ-9); помилку D1 логує app.ts.
  bot.on("callback_query", async (ctx) => {
    if (ctx.callbackQuery.message?.chat.type !== "private") return;
    const fromId = ctx.from.id;
    if (allowlist === null || !allowlist.has(fromId)) {
      await ctx.answerCallbackQuery({ text: PRIVATE_BOT_TEXT });
      return;
    }
    try {
      const user = await ensureUser(fromId, db, deps.clock.now());
      await handleCallback(ctx, captureDeps(user));
    } finally {
      await ctx.answerCallbackQuery();
    }
  });

  await bot.handleUpdate(update);
}

async function nextVariant(
  user: User,
  kind: VariantKind,
  pool: readonly string[],
  deps: BotDeps,
  db: Db,
): Promise<string> {
  const last = kind === "greet" ? user.greet_variant_idx : user.soon_variant_idx;
  const idx = pickVariant(pool.length, last, deps.rand);
  await setVariantIdx(user.id, kind, idx, db);
  return pool[idx] ?? pool[0] ?? "";
}
