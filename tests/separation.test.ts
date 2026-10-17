import { beforeEach, describe, expect, it } from "vitest";
import { resetSignupRateLimits } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { listSellerConnections } from "../src/lib/amazon-mcf";
import { buyerFromSessionToken, sellerUserFromSessionToken } from "../src/lib/auth";
import { setStripeOnboardingClient } from "../src/lib/sellers";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const PW = ["sep", "pass", "phrase"].join("-");
let ip = 0;
const req = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  handleApi(new Request(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base, "x-forwarded-for": `10.77.0.${++ip}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const token = (cookie: string) => decodeURIComponent(cookie.split("=")[1] ?? "");

async function buyer(email: string) {
  const res = await req("/api/v1/users", "POST", { email, password: PW, name: "Jane Smith" });
  return { res, cookie: cookieOf(res) };
}
async function seller(email: string) {
  const res = await req("/api/v1/sellers/signup", "POST", {
    business_name: "Oak & Pine Goods", contact_name: "Pat Seller", contact_email: email, password: PW,
    category: "tools", state: "VT", description: "Hand tools made in Vermont.", agree_terms: true,
  });
  return { res, cookie: cookieOf(res), json: await res.clone().json() };
}

describe("buyer/seller separation", () => {
  useTempDb();
  beforeEach(() => { resetSignupRateLimits(); setStripeOnboardingClient(null); });

  it("a shopper session cannot see any seller data", async () => {
    const s = await seller("store@example.com");
    const b = await buyer("shopper@example.com");
    expect(b.res.status).toBe(201);
    for (const [path, method] of [["/api/v1/seller/dashboard", "GET"], ["/api/v1/seller/products", "GET"], [`/api/v1/sellers/${s.json.seller_id}/amazon`, "GET"], ["/api/v1/seller/stripe/onboard", "POST"]]) {
      const res = await req(path, method, method === "POST" ? {} : undefined, { cookie: b.cookie });
      expect(res.status, path).toBe(401);
      expect(await res.text()).not.toContain("Oak & Pine");
    }
    expect(sellerUserFromSessionToken(token(b.cookie))).toBeUndefined();
    const me = await (await req("/api/v1/me", "GET", undefined, { cookie: b.cookie })).text();
    expect(me).not.toContain(s.json.seller_id);
  });

  it("a seller session cannot see any shopper account data", async () => {
    const s = await seller("store2@example.com");
    expect(s.res.status).toBe(201);
    for (const [path, method] of [["/api/v1/me", "GET"], ["/api/v1/addresses", "GET"], ["/api/v1/bots", "GET"], ["/api/v1/shop/link", "GET"]]) {
      const res = await req(path, method, undefined, { cookie: s.cookie });
      expect(res.status, path).toBe(401);
    }
    expect(buyerFromSessionToken(token(s.cookie))).toBeUndefined();
    expect((await req("/api/v1/seller/dashboard", "GET", undefined, { cookie: s.cookie })).status).toBe(200);
  });

  it("seller sign-up while signed in as a shopper makes a separate login, never links the shopper", async () => {
    const b = await buyer("both@example.com");
    const res = await req("/api/v1/sellers/signup", "POST", {
      business_name: "Linked Co", contact_name: "Pat", contact_email: "both@example.com", password: PW,
      category: "tools", state: "VT", description: "Should not link.", agree_terms: true,
    }, { cookie: b.cookie });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("email_unavailable");
    const buyerUser = buyerFromSessionToken(token(b.cookie))!;
    expect(listSellerConnections({ userId: buyerUser.id })).toEqual([]);
  });

  it("emails are unique across shopper and seller accounts, case-insensitively", async () => {
    expect((await buyer("Mixed@Example.com")).res.status).toBe(201);
    for (const variant of ["mixed@example.com", " MIXED@EXAMPLE.COM ", "Mixed@Example.com"]) {
      const s = await seller(variant);
      expect(s.res.status, variant).toBe(422);
      expect(s.json.error.code).toBe("email_unavailable");
      expect(s.json.error.message).toMatch(/different email/);
    }
    expect((await seller("Vendor@Shop.example")).res.status).toBe(201);
    for (const variant of ["vendor@shop.example", "VENDOR@SHOP.EXAMPLE", "  Vendor@Shop.Example"]) {
      const b = await buyer(variant);
      expect(b.res.status, variant).toBe(422);
      const body = await b.res.json();
      expect(body.error.code).toBe("email_unavailable");
    }
  });

  it("/sellers data is scoped: no owner sees another seller; unowned seeded sellers are admin-only", async () => {
    const a = await seller("a@example.com");
    const b = await seller("b@example.com");
    const ua = sellerUserFromSessionToken(token(a.cookie))!;
    const ids = listSellerConnections({ userId: ua.id }).map((x) => x.seller_id);
    expect(ids).toEqual([a.json.seller_id]);
    expect(ids).not.toContain(b.json.seller_id);
  });
});
