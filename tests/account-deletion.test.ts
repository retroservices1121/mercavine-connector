import { beforeEach, describe, expect, it } from "vitest";
import { PURGE_AFTER_DAYS, runPrivacyPurge } from "../src/lib/account-deletion";
import { resetSignupRateLimits } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { setNow } from "../src/lib/clock";
import { getDb } from "../src/lib/db";
import { resetEmailRateLimits } from "../src/lib/email-auth";
import { clearMailOutbox, mailOutbox } from "../src/lib/mailer";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const PW = ["correct", "horse", "battery"].join("-");
const json = (method: string, path: string, body: unknown, cookie = "") =>
  handleApi(new Request(`${base}${path}`, { method, headers: { "content-type": "application/json", origin: base, cookie, "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify(body) }));
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

describe("account deletion", () => {
  useTempDb();
  beforeEach(() => {
    resetSignupRateLimits();
    resetEmailRateLimits();
    clearMailOutbox();
  });

  async function signup(email: string) {
    const res = await json("POST", "/api/v1/users", { email, password: PW });
    expect(res.status).toBe(201);
    const id = (getDb().prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string }).id;
    return { cookie: cookieOf(res), id };
  }

  it("needs the password, deactivates at once and purges within 30 days", async () => {
    const { cookie, id } = await signup("del@example.com");
    expect((await json("POST", "/api/v1/me/delete", { password: "nope-nope-nope" }, cookie)).status).toBe(401);
    const res = await json("POST", "/api/v1/me/delete", { password: PW }, cookie);
    expect(res.status).toBe(202);
    expect(mailOutbox().some((m) => m.tag === "account-deletion" && m.to === "del@example.com")).toBe(true);
    // signed out and cannot sign back in
    expect((await handleApi(new Request(`${base}/api/v1/me`, { headers: { cookie } }))).status).toBe(401);
    expect((await json("POST", "/api/v1/session", { email: "del@example.com", password: PW })).status).toBe(401);

    // not yet due
    expect(runPrivacyPurge().users).toBe(0);
    setNow(new Date(Date.now() + (PURGE_AFTER_DAYS - 0.01) * 86_400_000));
    expect(runPrivacyPurge().users).toBe(0);
    setNow(new Date(Date.now() + (PURGE_AFTER_DAYS + 0.01) * 86_400_000));
    expect(runPrivacyPurge().users).toBe(1);
    const user = getDb().prepare(`SELECT email, name, password_hash, deleted_at FROM users WHERE id = ?`).get(id) as Record<string, string>;
    expect(user.email).not.toContain("del@example.com");
    expect(user.name).toBe("Deleted user");
    expect(user.password_hash).toBe("");
    expect(user.deleted_at).toBeTruthy();
    const left = (t: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(id) as { n: number }).n;
    expect(left("addresses")).toBe(0);
    expect(left("sessions")).toBe(0);
    expect(runPrivacyPurge().users).toBe(0); // idempotent
    expect(PURGE_AFTER_DAYS).toBeLessThan(30);
  });

  it("purges expired sessions and tokens", async () => {
    await signup("exp@example.com");
    setNow(new Date(Date.now() + 40 * 86_400_000));
    const result = runPrivacyPurge();
    expect(result.expired.sessions).toBeGreaterThan(0);
  });
});
