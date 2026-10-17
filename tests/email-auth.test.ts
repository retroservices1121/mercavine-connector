import { DEV_BOT_PUBLIC_KEY } from "@/lib/dev-keys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSignupRateLimits } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { approveCart } from "../src/lib/cart";
import { setNow } from "../src/lib/clock";
import { getDb } from "../src/lib/db";
import { resetEmailRateLimits, verifyEmail } from "../src/lib/email-auth";
import { clearMailOutbox, mailOutbox } from "../src/lib/mailer";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const PW = ["correct", "horse", "battery"].join("-");
const NEW_PW = ["purple", "stapler", "moon"].join("-");

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return handleApi(new Request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const tokenFrom = (text: string) => text.match(/token=([\w-]+)/)![1];
const lastMail = (to: string, tag: string) => [...mailOutbox()].reverse().find((m) => m.to === to && m.tag === tag);
const verified = (email: string) => (getDb().prepare(`SELECT email_verified FROM users WHERE email = ?`).get(email) as { email_verified: number }).email_verified;

async function signup(email: string) {
  const res = await post("/api/v1/users", { email, password: PW }, { "x-forwarded-for": `ip-${email}` });
  expect(res.status).toBe(201);
  return cookieOf(res);
}

describe("email verification and password reset", () => {
  useTempDb();
  beforeEach(() => {
    resetSignupRateLimits();
    resetEmailRateLimits();
    clearMailOutbox();
  });
  afterEach(() => setNow(null));

  it("emails a verification link from no-reply with privacy reply-to; the token is single use", async () => {
    await signup("v1@example.com");
    const mail = lastMail("v1@example.com", "verify_email")!;
    expect(mail.from).toContain("no-reply@mercavine.com");
    expect(mail.reply_to).toBe("privacy@mercavine.com");
    expect(mail.text).toContain("https://mercavine.com/verify?token=");
    const token = tokenFrom(mail.text);
    const stored = getDb().prepare(`SELECT COUNT(*) AS n FROM email_tokens WHERE token_hash = ?`).get(token) as { n: number };
    expect(stored.n).toBe(0);
    expect(verified("v1@example.com")).toBe(0);
    verifyEmail(token);
    expect(verified("v1@example.com")).toBe(1);
    expect(() => verifyEmail(token)).toThrow(/invalid or has expired/);
  });

  it("rejects an expired verification token and allows resend (rate limited)", async () => {
    const cookie = await signup("v2@example.com");
    const token = tokenFrom(lastMail("v2@example.com", "verify_email")!.text);
    setNow(new Date(Date.now() + 25 * 3_600_000));
    expect(() => verifyEmail(token)).toThrow(/invalid or has expired/);
    setNow(null);
    for (let i = 0; i < 3; i++) expect((await post("/api/v1/users/verify/resend", {}, { cookie })).status).toBe(200);
    expect((await post("/api/v1/users/verify/resend", {}, { cookie })).status).toBe(429);
    verifyEmail(tokenFrom(lastMail("v2@example.com", "verify_email")!.text));
    expect(verified("v2@example.com")).toBe(1);
  });

  it("gates web approval for an unverified shopper", async () => {
    await signup("v3@example.com");
    const id = (getDb().prepare(`SELECT id FROM users WHERE email = ?`).get("v3@example.com") as { id: string }).id;
    await expect(approveCart({ rawToken: "anything", userId: id, method: "dev_step_up" })).rejects.toMatchObject({ code: "email_unverified" });
  });

  it("forgot-password responds the same for known and unknown emails", async () => {
    await signup("r1@example.com");
    clearMailOutbox();
    const known = await post("/api/v1/password/forgot", { email: "r1@example.com" });
    const unknown = await post("/api/v1/password/forgot", { email: "nobody@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    expect(mailOutbox().map((m) => m.to)).toEqual(["r1@example.com"]);
    for (let i = 0; i < 5; i++) expect((await post("/api/v1/password/forgot", { email: "r1@example.com" })).status).toBe(200);
    expect(mailOutbox().filter((m) => m.tag === "password_reset").length).toBe(3);
  });

  it("resets the password once, revokes sessions and other reset tokens, keeps bot tokens", async () => {
    const cookie = await signup("r2@example.com");
    const bot = (await (await post("/api/v1/bots", { scopes: ["shop"], public_key_pem: DEV_BOT_PUBLIC_KEY }, { cookie })).json()) as { token: string };
    await post("/api/v1/password/forgot", { email: "r2@example.com" });
    await post("/api/v1/password/forgot", { email: "r2@example.com" });
    const resets = mailOutbox().filter((m) => m.tag === "password_reset");
    const first = tokenFrom(resets[0].text);
    const second = tokenFrom(resets[1].text);
    expect(resets[0].text).toContain("https://mercavine.com/reset-password?token=");

    expect((await post("/api/v1/password/reset", { token: second, password: "short" })).status).toBe(422);
    const ok = await post("/api/v1/password/reset", { token: second, password: NEW_PW });
    expect(ok.status).toBe(200);
    expect((await handleApi(new Request(`${base}/api/v1/me`, { headers: { cookie } }))).status).toBe(401);
    expect((await post("/api/v1/password/reset", { token: second, password: NEW_PW })).status).toBe(400);
    expect((await post("/api/v1/password/reset", { token: first, password: NEW_PW })).status).toBe(400);
    expect((await post("/api/v1/session", { email: "r2@example.com", password: PW })).status).toBe(401);
    expect((await post("/api/v1/session", { email: "r2@example.com", password: NEW_PW })).status).toBe(200);
    const search = await handleApi(new Request(`${base}/api/v1/products/search?q=hinge`, { headers: { authorization: `Bearer ${bot.token}` } }));
    expect(search.status).toBe(200);
  });

  it("expires reset tokens after 1 hour", async () => {
    await signup("r3@example.com");
    await post("/api/v1/password/forgot", { email: "r3@example.com" });
    const token = tokenFrom(lastMail("r3@example.com", "password_reset")!.text);
    setNow(new Date(Date.now() + 61 * 60_000));
    expect((await post("/api/v1/password/reset", { token, password: NEW_PW })).status).toBe(400);
  });
});
