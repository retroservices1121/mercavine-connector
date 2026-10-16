import { forgotPassword, isEmailVerified, resendVerification, resetPassword, sendVerification } from "./email-auth";
import { createAddress, createBot, createUser, deleteAddress, listAddresses, listBots, signupRateLimit, updateAddress } from "./accounts";
import { applyStripeAccountState, assertSellerAccess, createSellerAccount, createSellerProduct, listSellerProducts, refreshStripeStatus, sellerDashboard, sellerSignupRateLimit, startStripeOnboarding, updateSellerProduct } from "./sellers";
import { amazonSellerPublic, connectAmazonSeller, setPrimeEnrolled } from "./amazon-mcf";
import { login, logout, requireBot, requireUser, revokeBot, sessionCookie, clearSessionCookie, readCookie, assertSameOrigin, userFromSessionToken } from "./auth";
import { noteFailedApprovalLogin, approveCart, declineCart, editPending, changeApprovalAddress, askBotToRefresh, createCart, updateCart, submitCart, getCartForBot, cancelCart, humanOrders, notificationsFor, sweepExpired, finishShopPayForUser, cardSession, syncCardPayment, settleCardCart, noteCardFailure, type LineInput } from "./cart";
import { categoryLabels, brandSnapshot, searchNative } from "./catalog";
import { config } from "./config";
import { getDb } from "./db";
import { ApiError, errorBody } from "./errors";
import { many } from "./sql";
import { cancelOrder, getOrder, listOrders, markShipped, requestReturn } from "./orders";
import { authenticationOptions, registrationOptions, verifyAssertion, verifyRegistration } from "./passkeys";
import { lookupProduct, searchAcross } from "./search";
import { pollShopLink, shopLinkPublic, startShopLink, stripClientShopLine, verifyShopLines } from "./shop-pay";
import { webhookPublicJwks } from "./webhooks";
import { handleStripeEvent } from "./stripe-webhook";
import { newId } from "./ids";
import { nowIso } from "./clock";
import Stripe from "stripe";

function cors(status: number, body: unknown, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key, Signature, Signature-Input, Content-Digest, Mcp-Protocol-Version");
  headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

async function verifiedLines(value: unknown): Promise<LineInput[] | undefined> {
  if (!Array.isArray(value)) return undefined;
  const stripped = value.map((line) => stripClientShopLine((line ?? {}) as LineInput));
  return verifyShopLines(stripped);
}

function idempotencyKey(req: Request): string | undefined {
  return req.headers.get("idempotency-key") ?? undefined;
}

async function readJson(req: Request): Promise<{ raw: string; json: Record<string, unknown> }> {
  const raw = await req.text();
  if (!raw) return { raw: "", json: {} };
  try {
    return { raw, json: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    throw new ApiError(400, "bad_json", "Request body must be JSON.");
  }
}

export async function handleApi(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return cors(204, null);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  try {
    if (path === "/api/health") {
      getDb();
      sweepExpired();
      const cfg = config();
      return cors(200, {
        ok: true,
        brand: cfg.brandName,
        payment_mode: cfg.paymentMode,
        stripe_livemode: cfg.stripeLivemode,
        payments_ready: cfg.paymentMode === "mock" || Boolean(cfg.stripeSecretKey),
        stripe_webhook: Boolean(cfg.stripeWebhookSecret),
        fee_bps: cfg.platformFeeBps,
        shop_pay: cfg.shopPayMode,
        shop_catalog: cfg.shopCatalogEnabled,
        amazon_mcf: cfg.amazonMcfMode,
      });
    }
    if (path === "/api/well-known/webhook-keys") return cors(200, webhookPublicJwks());
    if (path === "/api/well-known/ucp") {
      const cfg = config();
      return cors(200, {
        name: cfg.brandName,
        version: "2026-08-25",
        capabilities: {
          "dev.ucp.shopping.catalog.search": [{ version: "2026-08-25" }],
          "dev.ucp.shopping.catalog.lookup": [{ version: "2026-08-25" }],
          "dev.shopify.catalog.global": [{ version: "2026-08-25" }],
        },
      });
    }
    if (path === "/api/v1/openapi.json") return cors(200, openApi());
    if (!path.startsWith("/api/v1/")) return cors(404, { error: { code: "not_found", message: "No such endpoint." } });
    const parts = path.slice("/api/v1/".length).split("/").filter(Boolean);
    return await route(req, url, parts);
  } catch (error) {
    if (error instanceof ApiError) {
      return cors(error.status, errorBody(error), error.headers);
    }
    console.error(error instanceof Error ? error.message : "internal");
    return cors(500, { error: { code: "internal", message: "Something went wrong on our side." } });
  }
}

async function route(req: Request, url: URL, parts: string[]): Promise<Response> {
  const method = req.method.toUpperCase();
  const rawBody = method === "GET" || method === "DELETE" ? "" : (await req.clone().text());

  if (parts[0] === "session" && method === "POST") {
    assertSameOrigin(req);
    const { json } = await readJson(req);
    try {
      const result = login(String(json.email ?? ""), String(json.password ?? ""));
      return cors(200, { user: result.user }, { "set-cookie": sessionCookie(result.token) });
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_login") noteFailedApprovalLogin(String(json.next ?? ""));
      throw error;
    }
  }
  if (parts[0] === "session" && method === "DELETE") {
    const token = readCookie(req, "mv_session");
    if (token) logout(token);
    return cors(204, null, { "set-cookie": clearSessionCookie() });
  }
  if (parts[0] === "me" && method === "GET") {
    const user = requireUser(req);
    const bots = many<{ id: string; name: string; revoked_at: string | null; approval_threshold_cents: number; per_month_limit_cents: number }>(
      getDb(),
      `SELECT id, name, revoked_at, approval_threshold_cents, per_month_limit_cents FROM bots WHERE user_id = ?`,
      user.id,
    );
    return cors(200, { user, bots, orders: humanOrders(user.id), notifications: notificationsFor(user.id), brand: brandSnapshot() });
  }
  if (parts[0] === "users" && parts.length === 1 && method === "POST") {
    assertSameOrigin(req);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
    signupRateLimit(ip);
    const { json } = await readJson(req);
    const created = createUser({ email: json.email, password: json.password, name: json.name });
    const session = login(created.email, String(json.password ?? ""));
    await sendVerification(created.id);
    return cors(201, { user: session.user, email_verified: false }, { "set-cookie": sessionCookie(session.token) });
  }
  if (parts[0] === "users" && parts[1] === "verify" && parts[2] === "resend" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    if (isEmailVerified(user.id)) return cors(200, { ok: true, email_verified: true });
    await resendVerification(user.id);
    return cors(200, { ok: true, email_verified: false });
  }
  if (parts[0] === "password" && parts[1] === "forgot" && method === "POST") {
    assertSameOrigin(req);
    const { json } = await readJson(req);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
    await forgotPassword(json.email, ip);
    return cors(200, { ok: true, message: "If an account exists for that email, we sent a reset link." });
  }
  if (parts[0] === "password" && parts[1] === "reset" && method === "POST") {
    assertSameOrigin(req);
    const { json } = await readJson(req);
    resetPassword(String(json.token ?? ""), json.password);
    return cors(200, { ok: true }, { "set-cookie": clearSessionCookie() });
  }
  if (parts[0] === "bots" && parts.length === 1 && method === "GET") {
    const user = requireUser(req);
    return cors(200, { bots: listBots(user.id) });
  }
  if (parts[0] === "bots" && parts.length === 1 && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    return cors(201, createBot(user.id, json), { "cache-control": "no-store" });
  }
  if (parts[0] === "addresses") {
    const user = requireUser(req);
    if (method === "GET" && parts.length === 1) return cors(200, { addresses: listAddresses(user.id) });
    assertSameOrigin(req);
    if (method === "POST" && parts.length === 1) {
      const { json } = await readJson(req);
      return cors(201, createAddress(user.id, json));
    }
    if (method === "PATCH" && parts.length === 2) {
      const { json } = await readJson(req);
      return cors(200, updateAddress(user.id, parts[1], json));
    }
    if (method === "DELETE" && parts.length === 2) {
      deleteAddress(user.id, parts[1]);
      return cors(204, null);
    }
    throw new ApiError(405, "method_not_allowed", "Unsupported address operation.");
  }
  if (parts[0] === "bots" && parts[2] === "revoke" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    return cors(200, revokeBot(parts[1], user.id));
  }
  if (parts[0] === "passkeys" && parts[1] === "register" && parts[2] === "options" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    return cors(200, await registrationOptions(user));
  }
  if (parts[0] === "passkeys" && parts[1] === "register" && parts[2] === "verify" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    return cors(200, await verifyRegistration(user.id, json as never));
  }
  if (parts[0] === "passkeys" && parts[1] === "authenticate" && parts[2] === "options" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    return cors(200, await authenticationOptions(user.id));
  }

  if (parts[0] === "approvals" && parts[2] === "approve" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    let assertionId: string | undefined;
    if (json.method === "passkey") {
      assertionId = await verifyAssertion(user.id, json.assertion as never);
    }
    const result = await approveCart({
      rawToken: decodeURIComponent(parts[1]),
      userId: user.id,
      method: json.method === "passkey" ? "passkey" : "dev_step_up",
      assertionId,
      acknowledgedChanges: Boolean(json.acknowledged_changes),
      failSellerId: typeof json.simulate_failure_seller_id === "string" ? json.simulate_failure_seller_id : undefined,
    });
    const waiting = !result.paid && (result.code === "shop_pay_approval" || result.code === "card_required");
    return cors(result.paid || waiting ? 200 : 402, result, { "cache-control": "no-store" });
  }
  if (parts[0] === "approvals" && parts[2] === "payment" && parts.length === 3 && method === "GET") {
    const user = requireUser(req);
    return cors(200, await cardSession({ rawToken: decodeURIComponent(parts[1]), userId: user.id }), { "cache-control": "no-store" });
  }
  if (parts[0] === "approvals" && parts[2] === "payment" && parts[3] === "sync" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    return cors(200, await syncCardPayment({ rawToken: decodeURIComponent(parts[1]), userId: user.id }), { "cache-control": "no-store" });
  }
  if (parts[0] === "approvals" && parts[2] === "decline" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    const cart = declineCart({
      rawToken: decodeURIComponent(parts[1]),
      userId: user.id,
      reason: String(json.reason ?? "not_now"),
      note: typeof json.note === "string" ? json.note : undefined,
      shareNote: Boolean(json.share_note),
    });
    return cors(200, { cart });
  }
  if (parts[0] === "approvals" && parts[2] === "edit" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    return cors(200, editPending({ rawToken: decodeURIComponent(parts[1]), userId: user.id, lines: (json.lines as { line_id: string; quantity: number }[]) ?? [] }));
  }
  if (parts[0] === "approvals" && parts[2] === "address" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    return cors(200, { cart: changeApprovalAddress(decodeURIComponent(parts[1]), user.id, String(json.address_id ?? "")) });
  }
  if (parts[0] === "approvals" && parts[2] === "refresh" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    return cors(200, askBotToRefresh(decodeURIComponent(parts[1]), user.id));
  }

  if (parts[0] === "shop" && parts[1] === "link" && method === "GET" && parts.length === 2) {
    const user = requireUser(req);
    return cors(200, shopLinkPublic(user.id));
  }
  if (parts[0] === "shop" && parts[1] === "link" && method === "POST" && parts.length === 2) {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    return cors(200, await startShopLink(user.id, String(json.device_name ?? "Mercavine")));
  }
  if (parts[0] === "shop" && parts[1] === "link" && parts[2] === "poll" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    return cors(200, await pollShopLink(user.id));
  }
  if (parts[0] === "shop" && parts[1] === "pay" && parts[3] === "finish" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    return cors(200, await finishShopPayForUser(parts[2], user.id));
  }

  if (parts[0] === "sellers" && parts[2] === "amazon" && parts[3] === "connect" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    assertSellerAccess(parts[1], user.id);
    return cors(200, connectAmazonSeller(parts[1]));
  }
  if (parts[0] === "sellers" && parts[2] === "amazon" && parts[3] === "prime" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    assertSellerAccess(parts[1], user.id);
    const { json } = await readJson(req);
    return cors(200, setPrimeEnrolled(parts[1], Boolean(json.enrolled)));
  }
  if (parts[0] === "sellers" && parts[2] === "amazon" && method === "GET" && parts.length === 3) {
    const user = requireUser(req);
    assertSellerAccess(parts[1], user.id);
    return cors(200, amazonSellerPublic(parts[1]));
  }

  if (parts[0] === "sellers" && parts[1] === "signup" && parts.length === 2 && method === "POST") {
    assertSameOrigin(req);
    const signedIn = sessionUserFromRequest(req);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
    sellerSignupRateLimit(`seller:${ip}`);
    const { json } = await readJson(req);
    const result = createSellerAccount(json, signedIn?.id);
    if (!result.created) return cors(201, { seller_id: result.seller.id, status: result.seller.status });
    const session = login(result.email, String(json.password ?? ""));
    await sendVerification(result.userId);
    return cors(201, { seller_id: result.seller.id, status: result.seller.status, email_verified: false }, { "set-cookie": sessionCookie(session.token) });
  }
  if (parts[0] === "seller" && parts[1] === "dashboard" && method === "GET") {
    const user = requireUser(req);
    return cors(200, sellerDashboard(user.id));
  }
  if (parts[0] === "seller" && parts[1] === "stripe" && parts[2] === "onboard" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    return cors(200, await startStripeOnboarding(user.id), { "cache-control": "no-store" });
  }
  if (parts[0] === "seller" && parts[1] === "stripe" && parts[2] === "refresh" && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    await refreshStripeStatus(user.id);
    return cors(200, sellerDashboard(user.id));
  }
  if (parts[0] === "seller" && parts[1] === "products" && parts.length === 2 && method === "GET") {
    const user = requireUser(req);
    return cors(200, { products: listSellerProducts(user.id) });
  }
  if (parts[0] === "seller" && parts[1] === "products" && parts.length === 2 && method === "POST") {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    return cors(201, createSellerProduct(user.id, json));
  }
  if (parts[0] === "seller" && parts[1] === "products" && parts.length === 3 && (method === "PATCH" || method === "PUT")) {
    assertSameOrigin(req);
    const user = requireUser(req);
    const { json } = await readJson(req);
    return cors(200, updateSellerProduct(user.id, parts[2], json));
  }

  if (parts[0] === "stripe" && parts[1] === "webhook" && method === "POST") {
    return stripeWebhook(req, rawBody);
  }
  if (parts[0] === "dev" && parts[1] === "orders" && parts[3] === "ship" && method === "POST") {
    if (!config().devTools) throw new ApiError(404, "not_found", "Dev tools are off.");
    const { json } = await readJson(req);
    return cors(200, markShipped(parts[2], String(json.carrier ?? "UPS"), String(json.tracking ?? "1ZDEV")));
  }

  const botScope = scopeFor(method, parts);
  const bot = await requireBot(req, rawBody, botScope);

  if (parts[0] === "products" && parts[1] === "search" && method === "GET") {
    const lane = url.searchParams.get("lane") ?? "native";
    const query = {
      q: url.searchParams.get("q") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      maxPrice: url.searchParams.get("max_price") ? Number(url.searchParams.get("max_price")) : undefined,
      inStock: url.searchParams.get("in_stock") !== "false",
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 10,
    };
    const found = await searchAcross(lane, query);
    return cors(200, { brand: config().brandName, lane, categories: categoryLabels(), results: found.results, shopify: found.shopify, shop: found.shop });
  }
  if (parts[0] === "products" && parts[1] && method === "GET" && parts[2] !== "offers") {
    const product = await lookupProduct(parts[1], url.searchParams.get("source") ?? undefined);
    if (!product) throw new ApiError(404, "not_found", "Product not found.");
    return cors(200, product);
  }
  if (parts[0] === "catalog" && parts[1] === "feed" && method === "GET") {
    const products = searchNative({ category: url.searchParams.get("category") ?? undefined, limit: 20, inStock: false });
    const ndjson = products.map((product) => JSON.stringify(product)).join("\n") + "\n";
    return new Response(ndjson, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  }
  if (parts[0] === "carts" && method === "POST" && parts.length === 1) {
    const { json } = await readJson(req);
    const lines = await verifiedLines(json.lines);
    const result = createCart({
      bot,
      lines,
      shippingAddressId: typeof json.shipping_address_id === "string" ? json.shipping_address_id : undefined,
      note: typeof json.note_for_human === "string" ? json.note_for_human : undefined,
      clientReference: typeof json.client_reference === "string" ? json.client_reference : undefined,
      fromCartId: typeof json.from_cart_id === "string" ? json.from_cart_id : undefined,
      idempotencyKey: idempotencyKey(req),
    });
    return cors(result.status, result.body, result.replayed ? { "idempotency-replayed": "true" } : undefined);
  }
  if (parts[0] === "carts" && parts[1] && method === "GET") {
    const cart = getCartForBot(bot, parts[1]);
    const etag = `"${cart.version}"`;
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return cors(200, cart, { etag });
  }
  if (parts[0] === "carts" && parts[1] && method === "PATCH") {
    const { json } = await readJson(req);
    const lines = json.lines === undefined ? undefined : await verifiedLines(json.lines);
    const result = updateCart({
      bot,
      cartId: parts[1],
      lines,
      shippingAddressId: typeof json.shipping_address_id === "string" ? json.shipping_address_id : undefined,
      note: typeof json.note_for_human === "string" ? json.note_for_human : undefined,
      idempotencyKey: idempotencyKey(req),
    });
    return cors(result.status, result.body);
  }
  if (parts[0] === "carts" && parts[2] === "submit" && method === "POST") {
    const { json } = await readJson(req);
    const result = submitCart({
      bot,
      cartId: parts[1],
      idempotencyKey: idempotencyKey(req),
      allowPartial: Boolean(json.allow_partial),
      notify: Array.isArray(json.notify) ? (json.notify as string[]) : [],
    });
    return cors(result.status, result.body);
  }
  if (parts[0] === "carts" && parts[2] === "cancel" && method === "POST") {
    const { json } = await readJson(req);
    const result = cancelCart({ bot, cartId: parts[1], reason: typeof json.reason === "string" ? json.reason : undefined, idempotencyKey: idempotencyKey(req) });
    return cors(result.status, result.body);
  }
  if (parts[0] === "orders" && method === "GET" && parts.length === 1) {
    return cors(200, { orders: listOrders(bot, url.searchParams.get("cart_id") ?? undefined) });
  }
  if (parts[0] === "orders" && parts[1] && method === "GET") return cors(200, getOrder(bot, parts[1]));
  if (parts[0] === "orders" && parts[2] === "cancel" && method === "POST") {
    const { json } = await readJson(req);
    const result = cancelOrder({ bot, orderId: parts[1], reason: typeof json.reason === "string" ? json.reason : undefined, idempotencyKey: idempotencyKey(req) });
    return cors(result.status, result.body);
  }
  if (parts[0] === "orders" && parts[2] === "returns" && method === "POST") {
    const { json } = await readJson(req);
    const result = requestReturn({
      bot,
      orderId: parts[1],
      lines: (json.lines as { line_id: string; quantity: number }[]) ?? [],
      reason: String(json.reason ?? "not_as_described"),
      idempotencyKey: idempotencyKey(req),
    });
    return cors(result.status, result.body);
  }
  if (parts[0] === "events" && method === "GET") {
    const after = url.searchParams.get("after");
    const types = url.searchParams.get("types");
    const rows = many<{ id: string; type: string; payload: string; created_at: string }>(
      getDb(),
      `SELECT id, type, payload, created_at FROM events WHERE user_id = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT 100`,
      bot.user_id,
      after,
      after,
    );
    const events = rows
      .map((row) => JSON.parse(row.payload) as { type: string })
      .filter((event) => !types || types.split(",").some((item) => (item.trim().endsWith(".*") ? event.type.startsWith(item.trim().slice(0, -1)) : event.type === item.trim())));
    return cors(200, { events });
  }
  if (parts[0] === "webhook_endpoints" && method === "POST") {
    const { json } = await readJson(req);
    const hookUrl = String(json.url ?? "");
    if (!hookUrl.startsWith("https://") && !hookUrl.startsWith("http://127.0.0.1") && !hookUrl.startsWith("http://localhost") && !hookUrl.startsWith("memory:")) {
      throw new ApiError(422, "https_required", "Webhook URLs must be https, except loopback in development.");
    }
    const id = newId("whe");
    getDb()
      .prepare(`INSERT INTO webhook_endpoints (id, bot_client_id, url, events, disabled_at, failure_since, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)`)
      .run(id, bot.id, hookUrl, Array.isArray(json.events) ? (json.events as string[]).join(",") : "cart.*,order.*", nowIso());
    return cors(201, { id, url: hookUrl });
  }

  throw new ApiError(404, "not_found", "No such endpoint.");
}

function scopeFor(method: string, parts: string[]): string {
  if (parts[0] === "products" || parts[0] === "catalog") return "search";
  if (parts[0] === "carts" && parts[2] === "submit") return "buy";
  if (parts[0] === "carts") return "cart";
  if (parts[0] === "orders" && parts[2] === "returns") return "returns";
  if (parts[0] === "orders" && parts[2] === "cancel") return "buy";
  if (parts[0] === "orders" || parts[0] === "events" || parts[0] === "webhook_endpoints") return "track";
  void method;
  return "search";
}

async function stripeWebhook(req: Request, raw: string): Promise<Response> {
  const cfg = config();
  type Evt = { id?: string; type?: string; account?: string; data?: { object?: Record<string, unknown> } };
  let event: Evt | null = null;
  if (cfg.stripeWebhookSecret) {
    // Comma-separated secrets allow one Connect endpoint and one platform endpoint (or a rotation).
    const header = req.headers.get("stripe-signature") ?? "";
    for (const secret of cfg.stripeWebhookSecret.split(",").map((x) => x.trim()).filter(Boolean)) {
      try {
        event = Stripe.webhooks.constructEvent(raw, header, secret) as unknown as Evt;
        break;
      } catch {
        /* try the next secret */
      }
    }
    if (!event) throw new ApiError(400, "bad_signature", "Stripe signature verification failed.");
  } else if (cfg.paymentMode === "mock") {
    event = JSON.parse(raw || "{}") as Evt;
  } else {
    throw new ApiError(400, "webhook_unconfigured", "Set STRIPE_WEBHOOK_SECRET to verify Stripe webhooks.");
  }
  const result = await handleStripeEvent(event, { applyStripeAccountState, settleCardCart, noteCardFailure });
  return cors(200, { received: true, ...result });
}

function openApi() {
  const cfg = config();
  return {
    openapi: "3.1.0",
    info: {
      title: `${cfg.brandName} bot API`,
      version: "0.1.0",
      description: `Search, cart, and approval-link checkout. The bot never receives card data. Platform fee default is ${cfg.platformFeeBps} basis points (${cfg.platformFeeBps / 100}%).`,
    },
    paths: {
      "/products/search": { get: { summary: "Search products" } },
      "/products/{id}": { get: { summary: "Get a product" } },
      "/carts": { post: { summary: "Create a cart. Requires Idempotency-Key." } },
      "/carts/{id}": { get: { summary: "Get a cart" }, patch: { summary: "Update a draft cart" } },
      "/carts/{id}/submit": { post: { summary: "Lock price and stock and return an approval URL" } },
      "/orders": { get: { summary: "List orders" } },
      "/orders/{id}": { get: { summary: "Order status without payment secrets" } },
    },
  };
}

export function sessionUserFromRequest(req: Request) {
  return userFromSessionToken(readCookie(req, "mv_session"));
}
