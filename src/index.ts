import { handleRequest } from "./app";
import { systemClock } from "./clock";
import type { AppEnv } from "./env";
import { runScheduled } from "./scheduled";

export default {
  fetch(request: Request, env: AppEnv): Promise<Response> {
    return handleRequest(request, env);
  },
  // Cron `* * * * *`: waitUntil тримає прогін живим до кінця; виняток видно в логах Cloudflare як збій cron.
  scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(env, systemClock));
  },
};
