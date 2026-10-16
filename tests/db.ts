import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/** Isolated SQLite file per test. The app caches one connection, so tests close it first. */
export function useTempDb() {
  let dir = "";
  beforeEach(async () => {
    const { closeDb } = await import("../src/lib/db");
    const { setNow } = await import("../src/lib/clock");
    const { resetRateLimits } = await import("../src/lib/auth");
    const { clearMemoryWebhooks } = await import("../src/lib/webhooks");
    closeDb();
    dir = mkdtempSync(join(tmpdir(), "mercavine-"));
    process.env.MERCAVINE_DB_PATH = join(dir, "test.sqlite");
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.PAYMENT_MODE;
    delete process.env.MERCAVINE_SAMPLE_CATALOG;
    process.env.PLATFORM_FEE_BPS = "300";
    process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4317";
    process.env.MERCAVINE_ALLOW_DEV_STEP_UP = "true";
    process.env.SHOPIFY_CATALOG_ENABLED = "false";
    process.env.SHOPIFY_IN_BOT_CHECKOUT = "false";
    delete process.env.SHOPIFY_CATALOG_ID;
    process.env.SHOP_CATALOG_ENABLED = "false";
    process.env.SHOP_PAY_ENABLED = "false";
    delete process.env.SHOP_PAY_MODE;
    delete process.env.SHOP_ACCESS_TOKEN;
    delete process.env.SHOP_DEV_CLIENT_ID;
    delete process.env.SHOP_DEV_CLIENT_SECRET;
    process.env.AMAZON_MCF_ENABLED = "false";
    delete process.env.AMAZON_MCF_MODE;
    delete process.env.AMAZON_LWA_CLIENT_ID;
    delete process.env.AMAZON_LWA_CLIENT_SECRET;
    delete process.env.AMAZON_SP_APP_ID;
    delete process.env.AMAZON_SP_API_ENDPOINT;
    delete process.env.AMAZON_SP_APP_DRAFT;
    delete process.env.AMAZON_LWA_TOKEN_URL;
    delete process.env.AMAZON_SELLER_CENTRAL_AUTHORIZE;
    delete process.env.AMAZON_MARKETPLACE_ID;
    process.env.MERCAVINE_REQUIRE_SIGNATURES = "false";
    process.env.MERCAVINE_DEV_TOOLS = "true";
    process.env.TOKEN_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    setNow(null);
    resetRateLimits();
    clearMemoryWebhooks();
    const { getDb } = await import("../src/lib/db");
    getDb();
  });
  afterEach(async () => {
    const { closeDb } = await import("../src/lib/db");
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
}
