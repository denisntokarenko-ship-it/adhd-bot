import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { Clock } from "./clock";
import { parseAllowlist } from "./config";
import { openDb, type Db } from "./db/index";
import { ensureUser, setVariantIdx, type User, type VariantKind } from "./db/users";
import type { AppEnv } from "./env";
import { GREET_POOL, PRIVATE_BOT_TEXT, SOON_POOL, pickVariant } from "./texts";

export interface BotDeps {
  clock: Clock;
  rand: () => number;
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

export async function processUpdate(update: Update, env: AppEnv, deps: BotDeps): Promise<void> {
  const token = env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is missing");
  const allowlist = parseAllowlist(env.ALLOWED_TG_IDS);
  if (allowlist === null) console.error("ALLOWED_TG_IDS is empty or invalid: rejecting everyone");
  const db = openDb(env);
  const bot = new Bot(token, { botInfo: botInfoFor(token) });

  // Не-текстові update-и й edited_message у Фазі 0 ігноруємо повністю: без відповіді й без запису (0.7.c).
  // Не-приватний чат — теж тиша, до перевірки allowlist: відповідь у групі бачать усі (0.6.d).
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    const fromId = ctx.from?.id;
    if (fromId === undefined || allowlist === null || !allowlist.has(fromId)) {
      await ctx.reply(PRIVATE_BOT_TEXT);
      return;
    }
    const user = await ensureUser(fromId, db, deps.clock.now());
    if (START_RE.test(ctx.message.text)) {
      await ctx.reply(await nextVariant(user, "greet", GREET_POOL, deps, db));
    } else {
      await ctx.reply(await nextVariant(user, "soon", SOON_POOL, deps, db));
    }
  });

  // Кнопок у Фазі 0 немає; на майбутнє кожен callback отримує відповідь (НФ-9).
  bot.on("callback_query", async (ctx) => {
    if (ctx.callbackQuery.message?.chat.type !== "private") return;
    const fromId = ctx.from.id;
    if (allowlist === null || !allowlist.has(fromId)) {
      await ctx.answerCallbackQuery({ text: PRIVATE_BOT_TEXT });
      return;
    }
    await ensureUser(fromId, db, deps.clock.now());
    await ctx.answerCallbackQuery();
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
