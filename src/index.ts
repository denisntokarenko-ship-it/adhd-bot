import { handleRequest } from "./app";
import type { AppEnv } from "./env";

export default {
  fetch(request: Request, env: AppEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
