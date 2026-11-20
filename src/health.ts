import type { Clock } from "./clock";
import { openDb } from "./db/index";
import { countPending, readHeartbeat } from "./db/system";
import type { AppEnv } from "./env";

export const STALE_AFTER_MS = 180_000;

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

// Лише перелічені поля: ні tg_id, ні імен, ні текстів, ні тексту помилок (0.2.e, НФ-8).
export async function healthResponse(env: AppEnv, clock: Clock): Promise<Response> {
  try {
    const db = openDb(env);
    const hb = await readHeartbeat(db, "cron");
    const pending = await countPending(db);
    const ageMs = hb ? clock.now() - hb.last_run_at : null;
    // 0.3.e: prod без пінгу монітора — «тихо живий» був би невидимий (НФ-6), тож ok:false, але 200.
    const monitorMissing = env.ENV === "production" && (env.MONITOR_PING_URL ?? "").trim() === "";
    const body = {
      ok: !monitorMissing,
      ...(monitorMissing ? { monitor: "missing" } : {}),
      env: env.ENV ?? "unknown",
      sha: env.GIT_SHA && env.GIT_SHA.trim() !== "" ? env.GIT_SHA : "unknown",
      cron: {
        last_run_at: hb ? hb.last_run_at : null,
        age_s: ageMs === null ? null : Math.floor(ageMs / 1000),
        stale: ageMs === null ? true : ageMs > STALE_AFTER_MS,
      },
      queue: { pending },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: HEADERS });
  } catch (err) {
    console.error("health: db error", err instanceof Error ? err.name : "unknown");
    return new Response(JSON.stringify({ ok: false, error: "db" }), { status: 503, headers: HEADERS });
  }
}
