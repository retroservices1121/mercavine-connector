import { beforeEach, describe, expect, it } from "vitest";
import { resetSignupRateLimits } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { getDb } from "../src/lib/db";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const PW = ["correct", "horse", "battery"].join("-");

function post(path: string, body: unknown, ip: string) {
  return handleApi(new Request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, origin: base }, body: JSON.stringify(body) }));
}
const count = (email: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM users WHERE email = ?`).get(email) as { n: number }).n;

describe("18+ self-attestation at sign-up", () => {
  useTempDb();
  beforeEach(() => resetSignupRateLimits());

  for (const [label, extra] of [["missing", {}], ["false", { age_confirmed: false }], ["string 'true'", { age_confirmed: "true" }]] as const) {
    it(`rejects shopper sign-up when age_confirmed is ${label}`, async () => {
      const res = await post("/api/v1/users", { email: "kid@example.com", password: PW, ...extra }, `10.1.0.${label.length}`);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("age_confirmation_required");
      expect(body.error.message).toMatch(/at least 18/);
      expect(count("kid@example.com")).toBe(0);
    });
  }

  it("creates the account and stores the attestation timestamp when confirmed", async () => {
    const res = await post("/api/v1/users", { email: "adult@example.com", password: PW, age_confirmed: true }, "10.1.1.1");
    expect(res.status).toBe(201);
    const row = getDb().prepare(`SELECT age_attested_at FROM users WHERE email = ?`).get("adult@example.com") as { age_attested_at: string | null };
    expect(row.age_attested_at).toBeTruthy();
    expect(Number.isNaN(Date.parse(row.age_attested_at!))).toBe(false);
  });

  it("blocks seller sign-up that creates a new account without the attestation", async () => {
    const seller = {
      business_name: "Granite Tools", contact_name: "Ada", contact_email: "seller-kid@example.com", password: PW,
      category: "tools", state: "NY", description: "Hand tools made in Vermont.", agree_terms: true,
    };
    const res = await post("/api/v1/sellers/signup", seller, "10.1.2.1");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("age_confirmation_required");
    expect(count("seller-kid@example.com")).toBe(0);
  });
});
