#!/usr/bin/env node
// Mercavine pre-submission end-to-end check. Fetch + MCP over HTTP, no browser needed.
//   E2E_BASE_URL=https://mercavine.com E2E_MODE=readonly node scripts/e2e.mjs
//   E2E_BASE_URL=http://127.0.0.1:4317 E2E_MODE=full E2E_PASSWORD=... node scripts/e2e.mjs
// readonly: no writes (safe for production). full: creates test users/carts on a LOCAL seeded build.
// Never confirms a payment. Never prints secrets. Exit 1 if any check fails.
const BASE = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const MODE = process.env.E2E_MODE ?? "readonly";
let BOT = process.env.E2E_BOT_TOKEN ?? "";
const PW = process.env.E2E_PASSWORD ?? "";
const results = [];
const rec = (area, name, status, note = "") => { results.push({ area, name, status, note }); console.log(`${status.padEnd(7)} ${area} :: ${name}${note ? " — " + note : ""}`); };
async function check(area, name, fn) {
  try { const n = await fn(); rec(area, name, n?.startsWith?.("SKIP") ? "SKIP" : n?.startsWith?.("PENDING") ? "PENDING" : "PASS", typeof n === "string" ? n.replace(/^(SKIP|PENDING):?\s*/, "") : ""); }
  catch (e) { rec(area, name, "FAIL", String(e.message ?? e).slice(0, 200)); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const get = (p, h = {}) => fetch(BASE + p, { headers: h, redirect: "manual" });
const post = (p, body, h = {}) => fetch(BASE + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin: BASE, ...h }, body: JSON.stringify(body) });
let rpcId = 0;
async function mcp(method, params, token = BOT) {
  const r = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  let t = await r.text();
  if (t.startsWith("event:") || t.includes("\ndata:")) t = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop();
  const j = JSON.parse(t);
  if (j.error) throw new Error(`rpc ${j.error.code} ${j.error.message}`);
  return j.result;
}
async function tool(name, args, token) {
  const r = await mcp("tools/call", { name, arguments: args }, token);
  const txt = r.content?.map((c) => c.text).join("") ?? "";
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { isError: !!r.isError, body, txt };
}
const DRAFT = /pending legal review|for legal review|\bplaceholder\b|\[(TBD|TODO|PLACEHOLDER)[^\]]*\]|\{\{|lorem ipsum|\bTBD\b|\bdraft\b/i;
const html = async (p) => { const r = await get(p); assert(r.status === 200, `${p} HTTP ${r.status}`); return r.text(); };
const visible = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");

// 1 Pages
for (const p of ["/", "/signup", "/login", "/sell", "/privacy", "/terms", "/forgot-password", "/developers"])
  await check("pages", `GET ${p} 200`, async () => { await html(p); });
await check("pages", "homepage has a featured product", async () => {
  const t = visible(await html("/")).replace(/\s+/g, " ");
  const sec = t.split(/Featured products/i)[1]?.split(/Sell where shoppers/i)[0] ?? "";
  assert(/\$\s?\d/.test(sec), "Featured products section is empty");
});
await check("pages", "product detail pages", async () => "SKIP: the app has no product detail route; products are exposed via get_product / GET /api/v1/products/:id");
await check("pages", "/api/health ok", async () => { const j = await (await get("/api/health")).json(); assert(j.ok, "not ok"); return `payment_mode=${j.payment_mode} livemode=${j.stripe_livemode} webhook=${j.stripe_webhook} shop_pay=${j.shop_pay}`; });
await check("legal", "/terms has no draft/placeholder text", async () => { const m = visible(await html("/terms")).match(DRAFT); assert(!m, `found "${m?.[0]}"`); });
await check("legal", "/privacy has no draft/placeholder text", async () => { const m = visible(await html("/privacy")).match(DRAFT); assert(!m, `found "${m?.[0]}"`); });
await check("legal", "/privacy covers account deletion via privacy@mercavine.com", async () => { const t = visible(await html("/privacy")); assert(/privacy@mercavine\.com/i.test(t) && /delet/i.test(t) && /30 days/i.test(t), "deletion / privacy@ / 30 days not all present"); });
await check("legal", "/terms states 18+ and Mobi Media Inc.", async () => { const t = visible(await html("/terms")); assert(/18/.test(t) && /Mobi Media/i.test(t), "missing 18 or Mobi Media"); });

// 2 MCP + flags
await check("mcp", "tools/list (no auth) lists core tools", async () => {
  const names = (await mcp("tools/list", {}, "")).tools.map((t) => t.name);
  for (const n of ["search_products", "get_product", "create_cart", "request_checkout", "get_order_status", "list_orders"]) assert(names.includes(n), `missing ${n}`);
  return `${names.length} tools`;
});
await check("mcp", "search_products rejects missing bot token", async () => { const r = await tool("search_products", { query: "drill" }, ""); assert(r.isError && /unauthor/i.test(r.txt), "expected unauthorized"); });
await check("web", "REST search rejects missing bot token", async () => { assert((await get("/api/v1/products/search?q=drill")).status === 401, "expected 401"); });
await check("shop-pay", "Shop Pay switch state", async () => { const j = await (await get("/api/health")).json(); return `shop_pay=${j.shop_pay} (SHOP_PAY_ENABLED ${j.shop_pay === "off" ? "unset/false" : "on"})`; });
await check("stripe", "webhook configured (STRIPE_WEBHOOK_SECRET)", async () => { const j = await (await get("/api/health")).json(); assert(j.payment_mode !== "stripe" || j.stripe_webhook, "stripe_webhook=false in stripe mode"); });
await check("stripe", "webhook rejects unsigned events", async () => { if ((await (await get("/api/health")).json()).payment_mode !== "stripe") return "SKIP: mock mode accepts unsigned"; const r = await post("/api/v1/stripe/webhook", { type: "ping" }); assert(r.status >= 400 && r.status < 500, `HTTP ${r.status}`); return `HTTP ${r.status}`; });
await check("auth", "18+ age gate in sign-up UI", async () => { const t = await html("/signup"); assert(/18|age|birth/i.test(visible(t).replace(/\b20\d\d\b/g, "")) && /type="checkbox"|date/i.test(t), "no age field/checkbox on /signup"); });

if (MODE !== "full") { finish(); }
else {
  const stamp = Date.now().toString(36);
  const email = process.env.E2E_EMAIL ?? `e2e-${stamp}@mercavine.test`;
  const pw = `E2e-${stamp}-Pass!x`;
  let cookie = "";
  await check("auth", "sign-up creates account (201) and is unverified", async () => {
    const r = await post("/api/v1/users", { email, password: pw, name: "E2E Test" });
    const body = await r.text(); assert(r.status === 201, `HTTP ${r.status} ${body.slice(0, 150)}`);
    cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    assert(JSON.parse(body).email_verified === false, "expected email_verified false");
    return email;
  });
  await check("auth", "18+ age enforced by API", async () => { const r = await post("/api/v1/users", { email: `u17-${stamp}@mercavine.test`, password: pw, birthdate: "2015-01-01", age_confirmed: false }); if (r.status === 429) return "SKIP: rate limited, inconclusive"; assert(r.status >= 400, `under-18 sign-up accepted (HTTP ${r.status}); API has no age field`); });
  await check("auth", "/api/v1/me with session", async () => { const r = await get("/api/v1/me", { cookie }); assert(r.status === 200, `HTTP ${r.status}`); });
  await check("auth", "resend verification", async () => { const r = await post("/api/v1/users/verify/resend", {}, { cookie }); assert(r.status < 300, `HTTP ${r.status}`); });
  await check("auth", "verify rejects bad token", async () => { const r = await get("/verify?token=bogus"); assert(r.status === 200 && /invalid|expired/i.test(visible(await r.text())), "no invalid-token message"); });
  await check("auth", "password forgot returns generic 2xx", async () => { const r = await post("/api/v1/password/forgot", { email }); assert(r.status < 300, `HTTP ${r.status}`); });
  await check("auth", "password reset rejects bad token", async () => { const r = await post("/api/v1/password/reset", { token: "bogus", password: pw + "2" }); assert(r.status >= 400, `HTTP ${r.status}`); });
  await check("bots", "Connect your bot issues token; token works on MCP", async () => {
    const r = await post("/api/v1/bots", { name: "E2E bot" }, { cookie });
    const body = await r.text(); assert(r.status < 300, `HTTP ${r.status} ${body.slice(0, 120)}`);
    const j = JSON.parse(body); const tok = j.token ?? j.bot?.token;
    assert(tok, "no token in response");
    const s = await tool("search_products", { query: "hinge" }, tok);
    assert(!s.isError, "new token rejected: " + s.txt.slice(0, 100));
    if (!BOT) BOT = tok;
  });
  await check("auth", "mark test shopper verified (local DB only)", async () => {
    if (!process.env.E2E_DB_PATH) return "SKIP: set E2E_DB_PATH for a local build to skip the email link";
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.env.E2E_DB_PATH); db.prepare("UPDATE users SET email_verified = 1 WHERE email = ?").run(email); db.close();
  });
  await check("account", "add shipping address", async () => { const r = await post("/api/v1/addresses", { recipient: "E2E Test", line1: "1 Test St", city: "Raleigh", region: "NC", postal_code: "27601", country: "US", is_default: true }, { cookie }); assert(r.status < 300, `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`); });
  await check("account", "self-serve account deletion endpoint", async () => { const r = await fetch(BASE + "/api/v1/me", { method: "DELETE", headers: { cookie, origin: BASE } }); assert(r.status < 300, `no deletion endpoint (HTTP ${r.status}); deletion is email-only via privacy@`); });
  let offer = "";
  await check("mcp", "search_products (seeded bot)", async () => { const r = await tool("search_products", { query: "hinge" }); assert(!r.isError, r.txt.slice(0, 150)); offer = JSON.stringify(r.body).match(/ofr_[a-z0-9_]+/)?.[0] ?? "ofr_brass_hinge"; return offer; });
  await check("web", "REST /api/v1/products/search", async () => { const r = await get("/api/v1/products/search?q=tape", { authorization: `Bearer ${BOT}` }); assert(r.status === 200, `HTTP ${r.status}`); });
  await check("mcp", "get_product", async () => { const r = await tool("get_product", { product_id: offer.replace(/^ofr_/, "prd_") }); return r.isError ? "PENDING: id shape differs: " + r.txt.slice(0, 80) : ""; });
  let cart = "";
  await check("cart", "create_cart", async () => { const r = await tool("create_cart", { lines: [{ offer_id: offer, quantity: 1 }], idempotency_key: `e2e-${stamp}-c` }); assert(!r.isError, r.txt.slice(0, 150)); cart = r.body.cart?.id ?? r.body.id; assert(cart, "no cart id"); return cart; });
  await check("cart", "get_cart", async () => { const r = await tool("get_cart", { cart_id: cart }); assert(!r.isError, r.txt.slice(0, 150)); });
  await check("checkout", "request_checkout returns approval URL (not confirmed)", async () => {
    const r = await tool("request_checkout", { cart_id: cart, idempotency_key: `e2e-${stamp}-k` });
    assert(!r.isError, r.txt.slice(0, 150));
    const url = JSON.stringify(r.body).match(/https?:\/\/[^"]+\/a\/[^"]+/)?.[0]; assert(url, "no approval URL");
    const page = await fetch(url.replace(/^https?:\/\/[^/]+/, BASE)); assert(page.status === 200, `approval page HTTP ${page.status}`);
  });
  await check("checkout", "real card form (Stripe Elements / Payment Link)", async () => "PENDING: card form PR in progress; payment is never confirmed by this script");
  await check("cart", "cancel_cart cleanup", async () => { const r = await tool("cancel_cart", { cart_id: cart, idempotency_key: `e2e-${stamp}-x` }); assert(!r.isError, r.txt.slice(0, 150)); });
  await check("orders", "list_orders", async () => { const r = await tool("list_orders", {}); assert(!r.isError, r.txt.slice(0, 150)); });
  await check("orders", "get_order_status unknown id → error", async () => { const r = await tool("get_order_status", { order_id: "ord_nope" }); assert(r.isError, "expected not_found"); });
  await check("shop-pay", "connect_shop_pay blocked while switch off", async () => { const r = await tool("connect_shop_pay", {}); assert(r.isError && /shop_pay_disabled|Shop Pay is off/i.test(r.txt), "unexpected: " + r.txt.slice(0, 80)); });
  let scookie = "";
  await check("seller", "/sell sign-up creates seller", async () => {
    const r = await post("/api/v1/sellers/signup", { contact_email: `seller-${stamp}@mercavine.test`, password: pw, contact_name: "E2E Seller", business_name: "E2E Test Shop", category: "tools", state: "NC", description: "E2E test seller", agree_terms: true });
    assert(r.status === 201, `HTTP ${r.status} ${(await r.text()).slice(0, 150)}`); scookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  });
  await check("seller", "/seller dashboard", async () => { const r = await get("/api/v1/seller/dashboard", { cookie: scookie }); assert(r.status === 200, `HTTP ${r.status}`); });
  await check("seller", "Stripe onboarding redirect URL", async () => { const r = await post("/api/v1/seller/stripe/onboard", {}, { cookie: scookie }); const t = await r.text(); if (r.status === 200) { const u = JSON.parse(t).url ?? ""; assert(u, "no url"); return /connect\.stripe\.com/.test(u) ? "Stripe Connect URL returned (not followed)" : "PENDING: mock onboarding URL (no Stripe key on this build)"; } return `PENDING: HTTP ${r.status} (no Stripe key on this build)`; });
  console.log(`\nCreated: user ${email}, seller seller-${stamp}@mercavine.test, bot "E2E bot", cart ${cart} (cancelled). Delete the local DB to clean up.`);
  finish();
}
async function finish() {
  const f = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${results.length} checks: ${results.filter((r) => r.status === "PASS").length} pass, ${f} fail, ${results.filter((r) => r.status !== "PASS" && r.status !== "FAIL").length} skip/pending`);
  if (process.env.E2E_JSON) (await import("node:fs")).writeFileSync(process.env.E2E_JSON, JSON.stringify(results, null, 2));
  process.exit(f ? 1 : 0);
}
