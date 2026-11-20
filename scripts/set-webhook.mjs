// scripts/set-webhook.mjs — виставляє вебхук Telegram і ПЕРЕВІРЯЄ його за відповіддю getWebhookInfo (спека 0.5.d).
// Використання:  node scripts/set-webhook.mjs https://adhd-bot-preview.<піддомен>.workers.dev/webhook
// Токен і секрет вводить людина в запиті (ввід прихований, у історію оболонки не потрапляє) або бере зі змінних
// середовища BOT_TOKEN / WEBHOOK_SECRET. Скрипт їх не друкує. JSON-тіло (а не рядок у curl) — лапки не обріжуть масив.
import { createInterface } from "node:readline";

export const ALLOWED_UPDATES = ["message", "callback_query"];

export function buildSetWebhookBody(url, secret) {
  return { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false };
}

// Висновок за ВІДПОВІДДЮ Telegram, а не за тим, що ми надіслали.
export function verifyWebhookInfo(info, url) {
  const problems = [];
  if (info.url !== url) problems.push(`url у Telegram: ${info.url}`);
  if (JSON.stringify(info.allowed_updates) !== JSON.stringify(ALLOWED_UPDATES)) {
    problems.push(`allowed_updates у Telegram: ${JSON.stringify(info.allowed_updates)}`);
  }
  if (info.last_error_message) problems.push(`last_error_message: ${info.last_error_message}`);
  return problems;
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(s);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function call(root, token, method, body) {
  const res = await fetch(`${root}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

async function main() {
  const url = process.argv[2];
  if (!url || !/^https:\/\/.+\/webhook$/.test(url)) {
    console.error("Вкажи URL вебхука: https://<worker>.workers.dev/webhook");
    process.exit(2);
  }
  const root = process.env.API_ROOT || "https://api.telegram.org";
  const token = process.env.BOT_TOKEN || (await askHidden("BOT_TOKEN (ввід прихований): "));
  const secret = process.env.WEBHOOK_SECRET || (await askHidden("WEBHOOK_SECRET (ввід прихований): "));
  if (!token || !secret) {
    console.error("Порожній токен або секрет — зупиняюсь.");
    process.exit(2);
  }
  const set = await call(root, token, "setWebhook", buildSetWebhookBody(url, secret));
  if (!set.ok) {
    console.error("setWebhook відхилено:", set.description);
    process.exit(1);
  }
  const info = await call(root, token, "getWebhookInfo");
  const problems = verifyWebhookInfo(info.result ?? {}, url);
  console.log("getWebhookInfo:", JSON.stringify({ url: info.result?.url, allowed_updates: info.result?.allowed_updates, last_error_message: info.result?.last_error_message ?? "" }));
  if (problems.length) {
    console.error("НЕ ГОТОВО:", problems.join("; "));
    process.exit(1);
  }
  console.log("ГОТОВО: вебхук виставлено, allowed_updates збігається, помилок немає.");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("set-webhook.mjs")) {
  main();
}
