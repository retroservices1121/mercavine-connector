import { beforeEach, describe, expect, it } from "vitest";
import { resetSignupRateLimits, SIGNUP_LIMIT_PER_HOUR } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { verifyEmail } from "../src/lib/email-auth";
import { mailOutbox } from "../src/lib/mailer";
import { getDb } from "../src/lib/db";
import { sha256 } from "../src/lib/ids";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const PW = ["correct", "horse", "battery"].join("-");

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return handleApi(new Request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
}

function cookieOf(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function signup(email: string, ip = "10.0.0.1") {
  const res = await post("/api/v1/users", { email, password: PW, name: "Test Shopper" }, { "x-forwarded-for": ip });
  return { res, cookie: cookieOf(res) };
}

describe("accounts", () => {
  useTempDb();
  beforeEach(() => resetSignupRateLimits());

  it("signs up, hashes the password, signs in, and rejects bad input with generic duplicate errors", async () => {
    const { res, cookie } = await signup("New.Shopper@Example.com");
    expect(res.status).toBe(201);
    expect(cookie).toMatch(/^mv_session=/);
    const row = getDb().prepare(`SELECT password_hash, email, email_verified FROM users WHERE email = ?`).get("new.shopper@example.com") as {
      password_hash: string; email_verified: number;
    };
    expect(row.password_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(row.password_hash).not.toContain(PW);
    expect(row.email_verified).toBe(0);

    const me = await handleApi(new Request(`${base}/api/v1/me`, { headers: { cookie } }));
    expect(me.status).toBe(200);

    const login = await post("/api/v1/session", { email: "new.shopper@example.com", password: PW });
    expect(login.status).toBe(200);

    const dup = await signup("new.shopper@example.com");
    expect(dup.res.status).toBe(422);
    expect(((await dup.res.json()) as { error: { code: string } }).error.code).toBe("signup_failed");

    expect((await post("/api/v1/users", { email: "not-an-email", password: PW })).status).toBe(422);
    expect((await post("/api/v1/users", { email: "short@example.com", password: "123456789" })).status).toBe(422);
  });

  it("rate-limits sign-up per client", async () => {
    for (let i = 0; i < SIGNUP_LIMIT_PER_HOUR; i++) {
      expect((await signup(`rl${i}@example.com`, "10.9.9.9")).res.status).toBe(201);
    }
    expect((await signup("rl-over@example.com", "10.9.9.9")).res.status).toBe(429);
    expect((await signup("rl-other@example.com", "10.9.9.10")).res.status).toBe(201);
  });

  it("manages addresses with a single default", async () => {
    const { cookie } = await signup("addr@example.com");
    const h = { cookie };
    const addr = { recipient: "Ada Lane", line1: "1 Main St", city: "Austin", region: "TX", postal_code: "78701" };
    const a = (await (await post("/api/v1/addresses", addr, h)).json()) as { id: string; is_default: boolean };
    expect(a.is_default).toBe(true);
    const b = (await (await post("/api/v1/addresses", { ...addr, label: "Work" }, h)).json()) as { id: string; is_default: boolean };
    expect(b.is_default).toBe(false);
    const patched = await handleApi(new Request(`${base}/api/v1/addresses/${b.id}`, { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ is_default: true, city: "Dallas" }) }));
    expect(patched.status).toBe(200);
    const list = (await (await handleApi(new Request(`${base}/api/v1/addresses`, { headers: h }))).json()) as { addresses: { id: string; is_default: boolean; city: string }[] };
    expect(list.addresses.filter((x) => x.is_default).map((x) => x.id)).toEqual([b.id]);
    expect(list.addresses.find((x) => x.id === b.id)?.city).toBe("Dallas");
    const del = await handleApi(new Request(`${base}/api/v1/addresses/${b.id}`, { method: "DELETE", headers: h }));
    expect(del.status).toBe(204);
    const after = (await (await handleApi(new Request(`${base}/api/v1/addresses`, { headers: h }))).json()) as { addresses: { id: string; is_default: boolean }[] };
    expect(after.addresses).toEqual([expect.objectContaining({ id: a.id, is_default: true })]);
    expect((await post("/api/v1/addresses", { ...addr, recipient: "" }, h)).status).toBe(422);
    expect((await handleApi(new Request(`${base}/api/v1/addresses`))).status).toBe(401);
  });

  it("connects a bot with chosen scopes, stores only the hash, and the bot needs an address to check out", async () => {
    const { cookie } = await signup("bot@example.com");
    expect((await post("/api/v1/bots", { name: "x" })).status).toBe(401);
    expect((await post("/api/v1/bots", { scopes: ["admin"] }, { cookie })).status).toBe(422);

    const res = await post("/api/v1/bots", { name: "Grok", scopes: ["shop", "checkout"], per_month_limit_cents: 50_000 }, { cookie });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as { id: string; token: string; scopes: string[]; per_month_limit_cents: number };
    expect(bot.token).toMatch(/^mv_bot_/);
    expect(bot.scopes).toEqual(["search", "cart", "buy", "addresses:read"]);
    expect(bot.per_month_limit_cents).toBe(50_000);
    const stored = getDb().prepare(`SELECT token_hash FROM bots WHERE id = ?`).get(bot.id) as { token_hash: string };
    expect(stored.token_hash).toBe(sha256(bot.token));

    const auth = { authorization: `Bearer ${bot.token}` };
    expect((await handleApi(new Request(`${base}/api/v1/products/search?q=hinge`, { headers: auth }))).status).toBe(200);
    expect((await handleApi(new Request(`${base}/api/v1/orders`, { headers: auth }))).status).toBe(403);

    const cart = { lines: [{ offer_id: "ofr_brass_hinge", quantity: 1 }] };
    const unverified = await post("/api/v1/carts", cart, { ...auth, "idempotency-key": "acct-cart-0" });
    expect(unverified.status).toBe(403);
    expect(((await unverified.json()) as { error: { code: string } }).error.code).toBe("email_unverified");
    const link = mailOutbox().find((m) => m.to === "bot@example.com" && m.tag === "verify_email")!.text.match(/token=([\w-]+)/)![1];
    verifyEmail(link);

    const noAddr = await post("/api/v1/carts", cart, { ...auth, "idempotency-key": "acct-cart-1" });
    expect(noAddr.status).toBe(422);
    expect(((await noAddr.json()) as { error: { code: string } }).error.code).toBe("address_required");

    await post("/api/v1/addresses", { recipient: "Bo T", line1: "2 Elm", city: "Reno", region: "NV", postal_code: "89501" }, { cookie });
    const ok = await post("/api/v1/carts", cart, { ...auth, "idempotency-key": "acct-cart-2" });
    expect(ok.status).toBe(201);

    const list = (await (await handleApi(new Request(`${base}/api/v1/bots`, { headers: { cookie } }))).json()) as { bots: { id: string }[] };
    expect(list.bots.map((b) => b.id)).toContain(bot.id);
    expect(JSON.stringify(list)).not.toContain(bot.token);
  });
});
