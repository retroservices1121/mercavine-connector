import { describe, expect, it } from "vitest";
import { useTempDb } from "./db";

describe("token encryption at rest", () => {
  useTempDb();

  it("round-trips with AES-256-GCM and never stores plaintext", async () => {
    const { sealToken, openToken, isSealed } = await import("../src/lib/token-crypto");
    const sealed = sealToken("Atzr|secret-refresh");
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("secret-refresh");
    expect(sealToken("Atzr|secret-refresh")).not.toBe(sealed); // random IV
    expect(openToken(sealed)).toBe("Atzr|secret-refresh");
    expect(sealToken(sealed)).toBe(sealed);
    expect(sealToken(null)).toBeNull();
  });

  it("rejects tampered ciphertext", async () => {
    const { sealToken, openToken } = await import("../src/lib/token-crypto");
    const sealed = sealToken("abc")!;
    const parts = sealed.split(":");
    parts[4] = Buffer.from("xyz").toString("base64url");
    expect(() => openToken(parts.join(":"))).toThrow();
  });

  it("fails closed when the key is unset", async () => {
    const { sealToken } = await import("../src/lib/token-crypto");
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => sealToken("abc")).toThrow(/not configured/);
    process.env.TOKEN_ENCRYPTION_KEY = "short";
    expect(() => sealToken("abc")).toThrow(/not configured/);
  });

  it("migrates legacy plaintext rows on startup", async () => {
    const { getDb, closeDb } = await import("../src/lib/db");
    const { openToken, isSealed } = await import("../src/lib/token-crypto");
    const db = getDb();
    const user = db.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string } | undefined;
    const userId = user?.id ?? "usr_legacy";
    if (!user) {
      db.prepare(`INSERT INTO users (id, email, name, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(userId, "l@example.com", "L", "L", "x", new Date().toISOString());
    }
    db.prepare(
      `INSERT INTO shop_links (user_id, status, device_code, access_token, created_at, updated_at) VALUES (?, 'linked', 'dev-plain', 'shop-plain', ?, ?)`,
    ).run(userId, "2026-01-01", "2026-01-01");
    closeDb();
    const reopened = getDb();
    const row = reopened.prepare(`SELECT access_token, device_code FROM shop_links WHERE user_id = ?`).get(userId) as { access_token: string; device_code: string };
    expect(isSealed(row.access_token)).toBe(true);
    expect(isSealed(row.device_code)).toBe(true);
    expect(openToken(row.access_token)).toBe("shop-plain");
  });
});
