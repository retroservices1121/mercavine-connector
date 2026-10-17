/**
 * Brand and runtime settings. The marketplace name is configurable so a
 * rename does not require a code sweep. Defaults are Mercavine.
 */

export type PaymentMode = "mock" | "stripe";

export type AppConfig = {
  brandName: string;
  brandHandle: string;
  brandDomain: string;
  brandLegalName: string;
  publicBaseUrl: string;
  dbPath: string;
  platformFeeBps: number;
  defaultTaxBps: number;
  draftTtlHours: number;
  defaultLockTtlMinutes: number;
  maxSellersPerCart: number;
  maxPendingCarts: number;
  requireSignatures: boolean;
  allowDevStepUp: boolean;
  devTools: boolean;
  stripeSecretKey: string | null;
  stripeLivemode: boolean;
  sampleCatalog: boolean;
  stripeWebhookSecret: string | null;
  stripePublishableKey: string | null;
  paymentMode: PaymentMode;
  shopifyCatalogEnabled: boolean;
  shopifyCatalogId: string | null;
  shopifyCatalogUrl: string;
  shopifyInBotCheckout: boolean;
  shopifyAgentProfile: string;
  shopCatalogEnabled: boolean;
  shopMcpUrl: string;
  shopPayEnabled: boolean;
  shopPayMode: "off" | "mock" | "live";
  shopDevClientId: string | null;
  shopDevClientSecret: string | null;
  amazonMcfEnabled: boolean;
  amazonMcfMode: "off" | "mock" | "live";
  amazonMcfLiveRequested: boolean;
  amazonLwaClientId: string | null;
  amazonLwaClientSecret: string | null;
  amazonSpAppId: string | null;
  amazonSpAppDraft: boolean;
  amazonSpApiEndpoint: string;
  amazonLwaTokenUrl: string;
  amazonSellerCentralAuthorize: string;
  amazonMarketplaceId: string;
  passkeyRpId: string;
  passkeyOrigin: string;
  contactName: string;
  contactRole: string;
  contactEmail: string;
  websiteUrl: string;
};

function shopPayModeFromEnv(): "off" | "mock" | "live" {
  if (process.env.SHOP_PAY_ENABLED !== "true") return "off";
  const forced = process.env.SHOP_PAY_MODE?.trim().toLowerCase();
  if (forced === "mock") return "mock";
  if (forced === "live") return "live";
  const token = process.env.SHOP_ACCESS_TOKEN?.trim() ?? "";
  return token.length > 10 ? "live" : "mock";
}

function amazonCredentialsReady(): boolean {
  const id = process.env.AMAZON_LWA_CLIENT_ID?.trim() ?? "";
  const secret = process.env.AMAZON_LWA_CLIENT_SECRET?.trim() ?? "";
  const app = process.env.AMAZON_SP_APP_ID?.trim() ?? "";
  return Boolean(id && secret && app);
}

function amazonMcfModeFromEnv(): "off" | "mock" | "live" {
  if (process.env.AMAZON_MCF_ENABLED !== "true") return "off";
  const forced = process.env.AMAZON_MCF_MODE?.trim().toLowerCase();
  if (forced === "live") return amazonCredentialsReady() ? "live" : "mock";
  return "mock";
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function config(): AppConfig {
  const stripe = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  // Secret (sk_) or restricted (rk_) keys are both accepted.
  const stripeKey = /^(sk|rk)_(live|test)_/.test(stripe) ? stripe : null;
  // PAYMENT_MODE=live forces Stripe and never falls back to mock: without a key, payments fail closed.
  // PAYMENT_MODE=mock forces mock. Unset: Stripe when a key is present, otherwise mock.
  const requestedMode = (process.env.PAYMENT_MODE ?? "").trim().toLowerCase();
  const paymentMode: PaymentMode =
    requestedMode === "live" || requestedMode === "stripe" ? "stripe" : requestedMode === "mock" ? "mock" : stripeKey ? "stripe" : "mock";
  // Sample-catalog sellers have no real Stripe accounts, so they are hidden outside mock mode unless forced on.
  const sampleEnv = (process.env.MERCAVINE_SAMPLE_CATALOG ?? "").trim();
  const sampleCatalog = sampleEnv ? sampleEnv !== "0" && sampleEnv !== "false" : paymentMode === "mock";
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4317").replace(
    /\/$/,
    "",
  );
  let passkeyOrigin = publicBaseUrl;
  let passkeyRpId = "localhost";
  try {
    const url = new URL(publicBaseUrl);
    passkeyOrigin = url.origin;
    passkeyRpId = url.hostname;
  } catch {
    /* keep defaults */
  }
  return {
    brandName: process.env.BRAND_NAME?.trim() || "Mercavine",
    brandHandle: process.env.BRAND_HANDLE?.trim() || "mercavine",
    brandDomain: process.env.BRAND_DOMAIN?.trim() || "mercavine.com",
    brandLegalName: process.env.BRAND_LEGAL_NAME?.trim() || "Mercavine",
    publicBaseUrl,
    dbPath: process.env.MERCAVINE_DB_PATH?.trim() || "data/mercavine.sqlite",
    // 300 basis points = 3% of each seller charge, collected as Stripe application_fee_amount.
    platformFeeBps: intEnv("PLATFORM_FEE_BPS", 300),
    defaultTaxBps: intEnv("DEFAULT_TAX_BPS", 750),
    draftTtlHours: intEnv("DRAFT_TTL_HOURS", 24),
    defaultLockTtlMinutes: intEnv("LOCK_TTL_MINUTES", 30),
    maxSellersPerCart: intEnv("MAX_SELLERS_PER_CART", 5),
    maxPendingCarts: intEnv("MAX_PENDING_CARTS", 3),
    requireSignatures: process.env.MERCAVINE_REQUIRE_SIGNATURES === "true",
    allowDevStepUp: process.env.MERCAVINE_ALLOW_DEV_STEP_UP !== "false",
    devTools: process.env.MERCAVINE_DEV_TOOLS !== "false",
    stripeSecretKey: stripeKey,
    stripeLivemode: Boolean(stripeKey?.includes("_live_")),
    sampleCatalog,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || null,
    stripePublishableKey: /^pk_(live|test)_/.test(process.env.STRIPE_PUBLISHABLE_KEY?.trim() ?? "") ? process.env.STRIPE_PUBLISHABLE_KEY!.trim() : null,
    paymentMode,
    shopifyCatalogEnabled: process.env.SHOPIFY_CATALOG_ENABLED === "true",
    shopifyCatalogId: process.env.SHOPIFY_CATALOG_ID?.trim() || null,
    shopifyCatalogUrl:
      process.env.SHOPIFY_CATALOG_MCP_URL?.trim() || "https://catalog.shopify.com/api/ucp/mcp",
    shopifyInBotCheckout: process.env.SHOPIFY_IN_BOT_CHECKOUT === "true",
    shopifyAgentProfile:
      process.env.SHOPIFY_UCP_AGENT_PROFILE?.trim() ||
      "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json",
    shopCatalogEnabled: process.env.SHOP_CATALOG_ENABLED !== "false",
    shopMcpUrl: (process.env.SHOP_MCP_URL?.trim() || "https://mcp.shop.com/").replace(/\/?$/, "/"),
    shopPayEnabled: process.env.SHOP_PAY_ENABLED === "true",
    shopPayMode: shopPayModeFromEnv(),
    shopDevClientId: process.env.SHOP_DEV_CLIENT_ID?.trim() || null,
    shopDevClientSecret: process.env.SHOP_DEV_CLIENT_SECRET?.trim() || null,
    amazonMcfEnabled: process.env.AMAZON_MCF_ENABLED === "true",
    amazonMcfMode: amazonMcfModeFromEnv(),
    amazonMcfLiveRequested: process.env.AMAZON_MCF_MODE?.trim().toLowerCase() === "live",
    amazonLwaClientId: process.env.AMAZON_LWA_CLIENT_ID?.trim() || null,
    amazonLwaClientSecret: process.env.AMAZON_LWA_CLIENT_SECRET?.trim() || null,
    amazonSpAppId: process.env.AMAZON_SP_APP_ID?.trim() || null,
    amazonSpAppDraft: process.env.AMAZON_SP_APP_DRAFT !== "false",
    amazonSpApiEndpoint:
      process.env.AMAZON_SP_API_ENDPOINT?.trim() || "https://sandbox.sellingpartnerapi-na.amazon.com",
    amazonLwaTokenUrl: process.env.AMAZON_LWA_TOKEN_URL?.trim() || "https://api.amazon.com/auth/o2/token",
    amazonSellerCentralAuthorize:
      process.env.AMAZON_SELLER_CENTRAL_AUTHORIZE?.trim() ||
      "https://sellercentral.amazon.com/apps/authorize/consent",
    amazonMarketplaceId: process.env.AMAZON_MARKETPLACE_ID?.trim() || "ATVPDKIKX0DER",
    passkeyRpId: process.env.PASSKEY_RP_ID?.trim() || passkeyRpId,
    passkeyOrigin: process.env.PASSKEY_ORIGIN?.trim() || passkeyOrigin,
    contactName: process.env.CONTACT_NAME?.trim() || "Joe Perez",
    contactRole: process.env.CONTACT_ROLE?.trim() || "CEO",
    contactEmail: process.env.CONTACT_EMAIL?.trim() || "support@mercavine.com",
    websiteUrl: process.env.WEBSITE_URL?.trim() || "",
  };
}

export function sellerStripeAccount(sellerId: string, stored: string): string {
  const override = process.env[`STRIPE_ACCOUNT_${sellerId.toUpperCase()}`]?.trim();
  return override || stored;
}
