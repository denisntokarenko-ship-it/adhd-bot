// scripts/set-commands.mjs — виставляє меню команд бота (`setMyCommands`) і ПЕРЕВІРЯЄ його за `getMyCommands` (S3.9).
// Використання:  node scripts/set-commands.mjs      (для preview — токен preview-бота, для prod — токен prod-бота)
// Токен вводить людина в запиті (ввід прихований) або бере зі змінної середовища BOT_TOKEN, як `set-webhook.mjs`.
// Скрипт його НІДЕ не друкує: ні в логах, ні в повідомленнях про помилки (друкується лише `description` Telegram).
import { createInterface } from "node:readline";

// Меню — те, що людина вживає щодня. `/start`, `/quiet`, `/tz` працюють, але не в меню (S3.9): `/quiet` і пояс — у `/settings`.
// Описи без докору й без слів-звинувачень (НФ-4); команди — малі латинські літери, 1–32 символи (вимога Telegram).
export const BOT_COMMANDS = [
  { command: "today", description: "що на сьогодні" },
  { command: "routines", description: "ліки й звички за розкладом" },
  { command: "settings", description: "налаштування: пояс, тиха ніч, огляди" },
  { command: "pause", description: "тиша на кілька годин" },
  { command: "resume", description: "зняти паузу" },
  { command: "export", description: "мої дані одним файлом" },
];

// Висновок за ВІДПОВІДДЮ Telegram (`getMyCommands`), а не за тим, що ми надіслали.
export function verifyCommands(got) {
  const problems = [];
  if (!Array.isArray(got) || got.length !== BOT_COMMANDS.length) {
    problems.push(`у Telegram ${Array.isArray(got) ? got.length : "?"} команд, очікувалось ${BOT_COMMANDS.length}`);
    return problems;
  }
  BOT_COMMANDS.forEach((c, i) => {
    if (got[i]?.command !== c.command || got[i]?.description !== c.description) problems.push(`команда №${i + 1}: у Telegram «${got[i]?.command}», очікувалась «${c.command}»`);
  });
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
  const root = process.env.API_ROOT || "https://api.telegram.org";
  const token = process.env.BOT_TOKEN || (await askHidden("BOT_TOKEN (ввід прихований): "));
  if (!token) {
    console.error("Порожній токен — зупиняюсь.");
    process.exit(2);
  }
  const set = await call(root, token, "setMyCommands", { commands: BOT_COMMANDS });
  if (!set.ok) {
    console.error("setMyCommands відхилено:", set.description);
    process.exit(1);
  }
  const got = await call(root, token, "getMyCommands");
  const problems = verifyCommands(got.result);
  console.log("getMyCommands:", JSON.stringify((got.result ?? []).map((c) => c.command)));
  if (problems.length) {
    console.error("НЕ ГОТОВО:", problems.join("; "));
    process.exit(1);
  }
  console.log("ГОТОВО: меню команд виставлено й збігається зі списком.");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("set-commands.mjs")) {
  main();
}
