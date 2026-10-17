import { beforeEach, describe, expect, it } from "vitest";
import { resetSignupRateLimits } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { closeDb, getDb } from "../src/lib/db";
import { resetEmailRateLimits } from "../src/lib/email-auth";
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from "../src/lib/lockout";
import { clearMailOutbox, mailOutbox } from "../src/lib/mailer";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const PW = ["correct", "horse", "battery"].join("-");

function post(path: string, body: unknown, ip: string) {
  return handleApi(
    new Request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}
const login = (email: string, password: string, ip = "198.51.100.1") => post("/api/v1/session", { email, password }, ip);
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("login lockout", () => {
  useTempDb();
  beforeEach(() => {
    resetSignupRateLimits();
    resetEmailRateLimits();
    clearMailOutbox();
  });

  async function signup(email: string) {
    const res = await post("/api/v1/users", { email, password: PW }, `signup-${email}`);
    expect(res.status).toBe(201);
  }

  it("locks an account after 10 failures, even with the right password, and survives a restart", async () => {
    await signup("lock1@example.com");
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) expect((await login("lock1@example.com", "wrong-password", `10.0.0.${i}`)).status).toBe(401);
    expect((await login("lock1@example.com", PW, "10.0.1.1")).status).toBe(200); // success resets the counter
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await login("lock1@example.com", "wrong-password", `10.0.2.${i}`);
    closeDb(); // persistent: a restart does not clear the lock
    getDb();
    const locked = await login("lock1@example.com", PW, "10.0.3.1");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    const audit = getDb().prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.locked'`).get() as { n: number };
    expect(audit.n).toBeGreaterThan(0);
  });

  it("locks an IP after 10 failures across different accounts", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await login(`nobody${i}@example.com`, "x-wrong-pass", "203.0.113.9");
    await signup("ipvictim@example.com");
    expect((await login("ipvictim@example.com", PW, "203.0.113.9")).status).toBe(429);
    expect((await login("ipvictim@example.com", PW, "203.0.113.10")).status).toBe(200);
  });

  it("emails an unlock link that lifts the lock", async () => {
    await signup("lock2@example.com");
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await login("lock2@example.com", "wrong-password", `10.1.0.${i}`);
    await settle();
    const mail = [...mailOutbox()].reverse().find((m) => m.to === "lock2@example.com" && m.tag === "unlock");
    expect(mail).toBeTruthy();
    const token = mail!.text.match(/token=([\w-]+)/)![1];
    const res = await handleApi(new Request(`${base}/api/v1/session/unlock?token=${token}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("unlocked=1");
    expect((await login("lock2@example.com", PW, "10.1.9.9")).status).toBe(200);
    const again = await handleApi(new Request(`${base}/api/v1/session/unlock?token=${token}`));
    expect(again.headers.get("location")).toContain("unlocked=0");
  });

  it("auto-unlocks after the lockout period", async () => {
    await signup("lock3@example.com");
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await login("lock3@example.com", "wrong-password", `10.2.0.${i}`);
    expect((await login("lock3@example.com", PW, "10.2.9.9")).status).toBe(429);
    getDb().prepare(`UPDATE login_failures SET locked_until = ?`).run(Date.now() - 1000);
    expect((await login("lock3@example.com", PW, "10.2.9.9")).status).toBe(200);
    expect(LOCKOUT_MINUTES).toBe(30);
  });
});
