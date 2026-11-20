import { describe, expect, it } from "vitest";
import { ALLOWED_UPDATES, buildSetWebhookBody, verifyWebhookInfo } from "../../scripts/set-webhook.mjs";

// 0.5.d: висновок «ГОТОВО» — лише за ВІДПОВІДДЮ getWebhookInfo, а не за тим, що ми надіслали (рев'ю 0.4, Д3).
const URL_OK = "https://adhd-bot-preview.example.workers.dev/webhook";
const goodInfo = { url: URL_OK, allowed_updates: ["message", "callback_query"] };

describe("scripts/set-webhook.mjs", () => {
  it("тіло setWebhook: секрет, allowed_updates, нічого не скидаємо", () => {
    expect(buildSetWebhookBody(URL_OK, "s3")).toEqual({
      url: URL_OK,
      secret_token: "s3",
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    expect(ALLOWED_UPDATES).toEqual(["message", "callback_query"]);
  });

  it("verifyWebhookInfo: правильна відповідь — без проблем", () => {
    expect(verifyWebhookInfo(goodInfo, URL_OK)).toEqual([]);
  });

  it("verifyWebhookInfo: інший url, інший або відсутній allowed_updates, last_error_message — кожне окремо червоне", () => {
    expect(verifyWebhookInfo({ ...goodInfo, url: "https://other.example/webhook" }, URL_OK)).toHaveLength(1);
    expect(verifyWebhookInfo({ ...goodInfo, allowed_updates: ["message"] }, URL_OK)).toHaveLength(1);
    expect(verifyWebhookInfo({ ...goodInfo, allowed_updates: ["callback_query", "message"] }, URL_OK)).toHaveLength(1); // порядок важливий
    expect(verifyWebhookInfo({ url: URL_OK }, URL_OK)).toHaveLength(1); // Telegram промовчав про allowed_updates
    expect(verifyWebhookInfo({ ...goodInfo, last_error_message: "Wrong response from the webhook: 401" }, URL_OK)).toHaveLength(1);
    expect(verifyWebhookInfo({}, URL_OK).length).toBeGreaterThanOrEqual(2); // порожня відповідь не «ГОТОВО»
  });
});
