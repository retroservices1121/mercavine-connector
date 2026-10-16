import { describe, expect, it } from "vitest";
import { login } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { DEV_SHOPPER } from "../src/lib/dev-keys";
import { purgeDemoIdentities } from "../src/lib/seed";
import { useTempDb } from "./db";

describe("demo purge", () => {
  useTempDb();

  it("hard-deletes demo identities and dependents, keeps the catalog, and is idempotent", () => {
    const db = getDb();
    login(DEV_SHOPPER.email, DEV_SHOPPER.password);
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const sellers = count("sellers");
    expect(count("users")).toBeGreaterThan(0);
    process.env.MERCAVINE_SEED_DEMO = "0";
    try {
      purgeDemoIdentities(db);
      purgeDemoIdentities(db);
    } finally {
      delete process.env.MERCAVINE_SEED_DEMO;
    }
    for (const t of ["users", "sessions", "addresses", "bots"]) expect(count(t)).toBe(0);
    expect(count("sellers")).toBe(sellers);
    expect(count("products")).toBeGreaterThan(0);
  });
});
