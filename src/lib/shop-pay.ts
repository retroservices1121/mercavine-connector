import { config } from "./config";
import { nowIso } from "./clock";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { newId, randomToken } from "./ids";
import { platformFeeCents } from "./money";
import { one, run } from "./sql";
import {
  SHOP_OAUTH,
  getShopProduct,
  rawShopId,
  shopProductId,
  callShopTool,
  setShopFetchForTests,
} from "./shop-mcp";

export { setShopFetchForTests };

export type ShopLine = {
  offer_id?: string;
  quantity: number;
  provider?: "native" | "shopify" | "shop";
  external_id?: string;
  title?: string;
  seller_name?: string;
  seller_id?: string;
  unit_price?: number;
  continue_url?: string;
  verifiedByServer?: boolean;
};

type LinkRow = {
  user_id: string;
  status: string;
  device_code: string | null;
  user_code: string | null;
  verification_uri: string | null;
  access_token: string | null;
  shop_email: string | null;
  shop_name: string | null;
};

export type ShopPayRequestRow = {
  id: string;
  cart_id: string;
  user_id: string;
  status: string;
  merchant_name: string;
  merchant_url: string;
  checkout_url: string;
  currency: string;
  amount_cents: number;
  approval_limit_cents: number;
  continue_url: string | null;
  shop_request_id: string | null;
  fee_cents: number;
};

/** Live only when Shop Pay is on and a buyer token exists. Otherwise mock, or off. */
export function shopPayRuntime(userId?: string): "off" | "mock" | "live" {
  const cfg = config();
  if (!cfg.shopPayEnabled || cfg.shopPayMode === "off") return "off";
  if (cfg.shopPayMode === "mock") return "mock";
  const linked = userId ? buyerToken(userId) : null;
  const envToken = process.env.SHOP_ACCESS_TOKEN?.trim() ?? "";
  if (linked || envToken.length > 10) return "live";
  return "mock";
}

function buyerToken(userId: string): string | null {
  const row = one<{ access_token: string | null }>(getDb(), `SELECT access_token FROM shop_links WHERE user_id = ? AND status = 'linked'`, userId);
  return row?.access_token || null;
}

function tokenFor(userId: string): string | null {
  return buyerToken(userId) || process.env.SHOP_ACCESS_TOKEN?.trim() || null;
}

export function shopLinkPublic(userId: string) {
  const row = one<LinkRow>(getDb(), `SELECT user_id, status, device_code, user_code, verification_uri, access_token, shop_email, shop_name FROM shop_links WHERE user_id = ?`, userId);
  const mode = shopPayRuntime(userId);
  return {
    enabled: config().shopPayEnabled,
    mode,
    linked: row?.status === "linked",
    email: row?.shop_email ?? null,
    name: row?.shop_name ?? null,
    user_code: row?.status === "pending" ? row.user_code : null,
    verification_uri: row?.status === "pending" ? row.verification_uri : null,
  };
}

export async function startShopLink(userId: string, deviceName: string) {
  const mode = shopPayRuntime(userId);
  if (mode === "off") throw new ApiError(403, "shop_pay_disabled", "Shop Pay is off. Set SHOP_PAY_ENABLED=true.");
  const label = deviceName.replace(/[^\w .,'&()-]/g, "").trim().slice(0, 64) || "Mercavine";
  const at = nowIso();
  if (mode === "mock") {
    const userCode = "MOCK";
    const uri = `${config().publicBaseUrl}/shop/link?code=${userCode}`;
    run(
      getDb(),
      `INSERT INTO shop_links (user_id, status, device_code, user_code, verification_uri, access_token, shop_email, shop_name, expires_at, created_at, updated_at)
       VALUES (?, 'pending', NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET status = 'pending', device_code = NULL, user_code = ?, verification_uri = ?, access_token = NULL, updated_at = ?`,
      userId,
      userCode,
      uri,
      at,
      at,
      userCode,
      uri,
      at,
    );
    return { mode, user_code: userCode, verification_uri: uri };
  }
  const body = new URLSearchParams({
    client_id: SHOP_OAUTH.clientId,
    resource: SHOP_OAUTH.resource,
    scope: SHOP_OAUTH.scope,
    device_name: label,
  });
  const response = await fetch(SHOP_OAUTH.deviceEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new ApiError(502, "shop_signin_failed", "Shop did not start Sign in with Shop.");
  const payload = (await response.json()) as { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string };
  if (!payload.device_code || !payload.user_code) throw new ApiError(502, "shop_signin_failed", "Shop did not return a sign-in code.");
  const uri = payload.verification_uri_complete || payload.verification_uri || "";
  run(
    getDb(),
    `INSERT INTO shop_links (user_id, status, device_code, user_code, verification_uri, access_token, shop_email, shop_name, expires_at, created_at, updated_at)
     VALUES (?, 'pending', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET status = 'pending', device_code = ?, user_code = ?, verification_uri = ?, access_token = NULL, updated_at = ?`,
    userId,
    payload.device_code,
    payload.user_code,
    uri,
    at,
    at,
    payload.device_code,
    payload.user_code,
    uri,
    at,
  );
  return { mode, user_code: payload.user_code, verification_uri: uri };
}

export async function pollShopLink(userId: string) {
  const mode = shopPayRuntime(userId);
  if (mode === "off") throw new ApiError(403, "shop_pay_disabled", "Shop Pay is off.");
  if (mode === "mock") {
    run(
      getDb(),
      `UPDATE shop_links SET status = 'linked', device_code = NULL, shop_email = ?, shop_name = 'Shop Pay', updated_at = ? WHERE user_id = ?`,
      "shopper@shop.example",
      nowIso(),
      userId,
    );
    return shopLinkPublic(userId);
  }
  const row = one<LinkRow>(getDb(), `SELECT user_id, status, device_code, user_code, verification_uri, access_token, shop_email, shop_name FROM shop_links WHERE user_id = ?`, userId);
  if (!row?.device_code) throw new ApiError(409, "shop_signin_missing", "Start Sign in with Shop first.");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: SHOP_OAUTH.clientId,
    device_code: row.device_code,
  });
  const response = await fetch(SHOP_OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const payload = (await response.json()) as { access_token?: string; error?: string };
  if (payload.error === "authorization_pending" || payload.error === "slow_down") {
    return { ...shopLinkPublic(userId), pending: true };
  }
  if (!response.ok || !payload.access_token) {
    throw new ApiError(401, "shop_signin_failed", "Shop has not approved this sign-in yet.");
  }
  run(
    getDb(),
    `UPDATE shop_links SET status = 'linked', device_code = NULL, access_token = ?, updated_at = ? WHERE user_id = ?`,
    payload.access_token,
    nowIso(),
    userId,
  );
  return shopLinkPublic(userId);
}

export async function verifyShopLines<T extends ShopLine>(lines: T[]): Promise<(T & { verifiedByServer?: boolean })[]> {
  const checked: T[] = [];
  for (const line of lines) {
    const provider = line.provider ?? (line.offer_id ? "native" : undefined);
    if (provider !== "shop") {
      checked.push({ ...line, verifiedByServer: undefined });
      continue;
    }
    if (shopPayRuntime() === "off") {
      throw new ApiError(403, "shop_pay_disabled", "Shop Pay is off. Set SHOP_PAY_ENABLED=true.");
    }
    if (config().shopCatalogEnabled) {
      const product = await getShopProduct(line.external_id || line.offer_id || "");
      const wanted = shopProductId(rawShopId(line.external_id || line.offer_id || ""));
      const offer = product?.offers.find((item) => item.offer_id === wanted) ?? product?.offers[0];
      if (!product || !offer?.linkable || offer.available !== true || !offer.price || !offer.checkout_url) {
        throw new ApiError(409, "unavailable", "That Shop listing is missing fields or is not available, so it was not linked.", {
          missing: [...(product?.missing ?? []), ...(offer?.missing ?? ["product"])],
        });
      }
      checked.push({
        ...line,
        provider: "shop",
        verifiedByServer: true,
        external_id: offer.offer_id,
        title: product.title,
        seller_name: offer.seller.name,
        seller_id: offer.seller.domain || offer.seller.id,
        unit_price: offer.price.amount,
        continue_url: offer.checkout_url,
      });
      continue;
    }
    const missing: string[] = [];
    if (!line.title?.trim()) missing.push("title");
    if (!line.unit_price || line.unit_price <= 0) missing.push("price");
    if (!line.seller_name?.trim()) missing.push("seller");
    if (!line.external_id?.trim()) missing.push("id");
    if (!line.continue_url || !/^https:\/\//i.test(line.continue_url)) missing.push("url");
    if (missing.length) {
      throw new ApiError(409, "unavailable", "Shop Pay needs a title, price, seller, variant id, and https checkout URL before linking.", { missing });
    }
    checked.push({ ...line, provider: "shop", verifiedByServer: true });
  }
  return checked;
}

export function readShopPay(cartId: string): ShopPayRequestRow | undefined {
  return one<ShopPayRequestRow>(getDb(), `SELECT * FROM shop_pay_requests WHERE cart_id = ? ORDER BY created_at DESC LIMIT 1`, cartId);
}

export function readShopPayById(id: string): ShopPayRequestRow | undefined {
  return one<ShopPayRequestRow>(getDb(), `SELECT * FROM shop_pay_requests WHERE id = ?`, id);
}

export function stripClientShopLine<T extends ShopLine>(line: T): T {
  const copy = { ...line };
  delete copy.verifiedByServer;
  return copy;
}

export function shopPayPublic(row: ShopPayRequestRow | undefined) {
  if (!row) return null;
  return {
    status: row.status,
    continue_url: row.continue_url,
    merchant_name: row.merchant_name,
    amount_cents: row.amount_cents,
    currency: row.currency,
    fee_cents: 0,
    payment_provider: "shop_pay" as const,
  };
}

export function assertShopPayFee(amountCents: number): 0 {
  const fee = platformFeeCents("shop_pay", amountCents, config().platformFeeBps);
  if (fee !== 0) throw new ApiError(500, "fee_invariant", "Shop Pay orders cannot carry a platform fee.");
  return 0;
}

export async function openShopPayRequest(input: {
  id: string;
  cartId: string;
  userId: string;
  merchantName: string;
  merchantUrl: string;
  checkoutUrl: string;
  currency: string;
  amountCents: number;
  summary: string;
}): Promise<{ continue_url: string; shop_request_id: string | null }> {
  const mode = shopPayRuntime(input.userId);
  if (mode === "off") throw new ApiError(403, "shop_pay_disabled", "Shop Pay is off.");
  assertShopPayFee(input.amountCents);
  let continueUrl = `${config().publicBaseUrl}/shop-pay/mock/${input.id}`;
  let shopRequestId: string | null = null;
  if (mode === "live") {
    const token = tokenFor(input.userId);
    if (!token) throw new ApiError(409, "shop_not_linked", "Sign in with Shop before paying.");
    const result = await callShopTool(
      "create_spend_request",
      {
        spend_request: {
          business: { name: input.merchantName, url: input.merchantUrl, country: "US" },
          currency: input.currency.toUpperCase(),
          totals: { total: input.amountCents },
          approval_limit: input.amountCents,
          context: { intent: input.summary },
        },
      },
      token,
    );
    if (!result.ok) throw new ApiError(502, "shop_pay_failed", "Shop Pay did not open an approval.");
    const pub = publicSpend(result.payload);
    if (!pub.continue_url) throw new ApiError(502, "shop_pay_failed", "Shop Pay did not return an approval link.");
    continueUrl = pub.continue_url;
    shopRequestId = pub.id ?? null;
  }
  const at = nowIso();
  run(
    getDb(),
    `INSERT INTO shop_pay_requests (
      id, cart_id, user_id, status, merchant_name, merchant_url, checkout_url, currency, amount_cents, approval_limit_cents, continue_url, shop_request_id, fee_cents, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending_shop', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    input.id,
    input.cartId,
    input.userId,
    input.merchantName,
    input.merchantUrl,
    input.checkoutUrl,
    input.currency,
    input.amountCents,
    input.amountCents,
    continueUrl,
    shopRequestId,
    at,
    at,
  );
  return { continue_url: continueUrl, shop_request_id: shopRequestId };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function publicSpend(payload: unknown): { id?: string; continue_url?: string } {
  const root = asRecord(payload);
  const result = asRecord(root?.result) ?? root;
  const content = asRecord(result?.structuredContent) ?? result;
  const spend = asRecord(content?.spend_request) ?? content;
  const id = typeof spend?.id === "string" ? spend.id : undefined;
  const continueUrl = typeof spend?.continue_url === "string" ? spend.continue_url : typeof content?.continue_url === "string" ? content.continue_url : undefined;
  return { id, continue_url: continueUrl && continueUrl.startsWith("https://") ? continueUrl : continueUrl?.startsWith("http://127.0.0.1") ? continueUrl : undefined };
}

type Cred = { number: string; exp_month: string; exp_year: string; cvv: string; name: string };

function takeInstrument(value: unknown, depth = 0): Cred | null {
  if (!value || typeof value !== "object" || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = takeInstrument(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const rec = value as Record<string, unknown>;
  const number = rec.number ?? rec.pan ?? rec.card_number;
  if (typeof number === "string" && number.length >= 12) {
    return {
      number,
      exp_month: String(rec.exp_month ?? rec.expiry_month ?? ""),
      exp_year: String(rec.exp_year ?? rec.expiry_year ?? ""),
      cvv: String(rec.cvv ?? rec.cvc ?? ""),
      name: String(rec.name ?? rec.cardholder ?? ""),
    };
  }
  for (const inner of Object.values(rec)) {
    const found = takeInstrument(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

async function submitMerchantCheckout(url: string, credential: Cred): Promise<string> {
  if (!/^https:\/\//i.test(url)) throw new ApiError(422, "bad_checkout_url", "Merchant checkout must be https.");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ shop_pay_credential: credential }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new ApiError(502, "merchant_checkout_failed", "The merchant checkout did not accept Shop Pay. The credential was discarded.");
  return `shop_live_${newId("ord")}`;
}

/** Uses a single-use credential in memory, then drops it. Nothing about the card is returned or stored. */
export async function claimShopPay(row: ShopPayRequestRow, userId: string): Promise<{ orderRef: string }> {
  const mode = shopPayRuntime(userId);
  if (mode === "mock") {
    const credential: Cred = { number: "", exp_month: "", exp_year: "", cvv: "", name: "" };
    credential.number = `mock-${randomToken(8)}`;
    try {
      if (!/^https:\/\//i.test(row.checkout_url)) throw new ApiError(422, "bad_checkout_url", "Merchant checkout must be https.");
      return { orderRef: `shop_mock_${row.id}` };
    } finally {
      credential.number = "";
      credential.cvv = "";
    }
  }
  const token = tokenFor(userId);
  if (!token) throw new ApiError(409, "shop_not_linked", "Sign in with Shop before paying.");
  const loaded = await callShopTool("get_spend_request", { id: row.shop_request_id }, token);
  if (!loaded.ok) throw new ApiError(502, "shop_pay_failed", "Shop Pay could not be read.");
  let credential = takeInstrument(loaded.payload);
  if (!credential) throw new ApiError(409, "shop_pay_pending", "Shop Pay is still waiting for the shopper to approve this purchase.");
  try {
    const orderRef = await submitMerchantCheckout(row.checkout_url, credential);
    await callShopTool("complete_spend_request", { id: row.shop_request_id, result: { status: "success", order: { id: orderRef } } }, token);
    return { orderRef };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Merchant checkout failed.";
    await callShopTool(
      "complete_spend_request",
      { id: row.shop_request_id, result: { status: "error", failure_code: "merchant_checkout_failed", message } },
      token,
    ).catch(() => undefined);
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "merchant_checkout_failed", "The merchant checkout did not complete. The credential was discarded.");
  } finally {
    if (credential) {
      credential.number = "";
      credential.cvv = "";
      credential.name = "";
      credential = null;
    }
  }
}

export function markShopPayPaid(requestId: string) {
  run(getDb(), `UPDATE shop_pay_requests SET status = 'paid', fee_cents = 0, updated_at = ? WHERE id = ?`, nowIso(), requestId);
}
