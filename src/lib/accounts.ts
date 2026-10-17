import { createPublicKey } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./clock";
import { getDb, transaction } from "./db";
import { ApiError } from "./errors";
import { newId, randomToken, sha256 } from "./ids";
import { hashPassword } from "./password";
import { many, one, run } from "./sql";

// ---------- sign-up ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD_LENGTH = 10;

const signupBuckets = new Map<string, { count: number; reset: number }>();
export const SIGNUP_LIMIT_PER_HOUR = 5;

/** Per-client sign-up limiter (in-memory, per instance). */
export function signupRateLimit(key: string) {
  const now = Date.now();
  let bucket = signupBuckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + 3_600_000 };
    signupBuckets.set(key, bucket);
  }
  if (bucket.count >= SIGNUP_LIMIT_PER_HOUR) {
    const retry = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    throw new ApiError(429, "rate_limited", "Too many sign-up attempts. Try again later.", undefined, { "Retry-After": String(retry) });
  }
  bucket.count += 1;
}

export function resetSignupRateLimits() {
  signupBuckets.clear();
}

/** Trim, Unicode-normalize (NFKC) and lowercase, so case variants of one address collide. */
export function normalizeEmail(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

export function createUser(input: { email: unknown; password: unknown; name?: unknown; accountType?: "buyer" | "seller" }): { id: string; email: string } {
  const email = normalizeEmail(input.email);
  const password = String(input.password ?? "");
  const name = String(input.name ?? "").trim().slice(0, 80) || email.split("@")[0];
  if (!EMAIL_RE.test(email) || email.length > 254) throw new ApiError(422, "invalid_email", "Enter a valid email address.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(422, "weak_password", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 200) throw new ApiError(422, "weak_password", "Password is too long.");
  const id = newId("usr");
  const created = transaction((db) => {
    // Shopper and seller logins share one email namespace: an email used by either kind can't be reused by the other.
    if (one(db, `SELECT id FROM users WHERE lower(trim(email)) = ?`, email)) return false;
    // TODO(email-verification): email_verified stays 0 until a verification flow exists.
    run(
      db,
      `INSERT INTO users (id, email, name, display_name, password_hash, created_at, email_verified, account_type) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      id, email, name, name, hashPassword(password), nowIso(), input.accountType ?? "buyer",
    );
    return true;
  });
  // Same message whether the email belongs to a shopper or a seller account, so it never reveals which kind exists.
  // (Saying "use a different email" unavoidably hints the email is taken; sign-up is rate limited.)
  if (!created) throw new ApiError(422, "email_unavailable", "That email can't be used for a new account. Please use a different email address.");
  return { id, email };
}

// ---------- bots ----------

/** User-facing scope groups mapped to the API scopes the connector checks. */
export const SCOPE_GROUPS: Record<string, string[]> = {
  shop: ["search"],
  checkout: ["cart", "buy", "addresses:read"],
  track: ["track", "returns"],
};

export const BOT_DEFAULT_LIMITS = {
  per_order_limit_cents: 25_000,
  per_day_limit_cents: 80_000,
  per_month_limit_cents: 200_000,
  approval_threshold_cents: 10_000,
};

function cents(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new ApiError(422, "invalid_limit", `${field} must be a whole number of cents.`);
  return n;
}

export function createBot(
  userId: string,
  input: { name?: unknown; scopes?: unknown; public_key_pem?: unknown; mcp_only?: unknown; per_order_limit_cents?: unknown; per_month_limit_cents?: unknown; approval_threshold_cents?: unknown },
) {
  const name = String(input.name ?? "").trim().slice(0, 80) || "My bot";
  const groups = Array.isArray(input.scopes) ? input.scopes.map(String) : ["shop", "checkout", "track"];
  if (!groups.length || groups.some((g) => !SCOPE_GROUPS[g])) {
    throw new ApiError(422, "invalid_scopes", "Scopes must be one or more of shop, checkout, track.");
  }
  const scopes = [...new Set(groups.flatMap((g) => SCOPE_GROUPS[g]))];
  const mcpOnly = input.mcp_only === true;
  let publicKey: string | null = null;
  const hasKey = typeof input.public_key_pem === "string" && input.public_key_pem.trim() !== "";
  if (!hasKey && !mcpOnly) {
    throw new ApiError(422, "public_key_required", "An Ed25519 public key (PEM) is required to sign this bot's requests.");
  }
  if (hasKey && typeof input.public_key_pem === "string") {
    try {
      const key = createPublicKey(input.public_key_pem.trim());
      if (key.asymmetricKeyType !== "ed25519") throw new Error("type");
      publicKey = key.export({ type: "spki", format: "pem" }).toString();
    } catch {
      throw new ApiError(422, "invalid_public_key", "Public key must be an Ed25519 key in PEM format.");
    }
  }
  const limits = { ...BOT_DEFAULT_LIMITS };
  const perOrder = cents(input.per_order_limit_cents, "per_order_limit_cents");
  const perMonth = cents(input.per_month_limit_cents, "per_month_limit_cents");
  const threshold = cents(input.approval_threshold_cents, "approval_threshold_cents");
  if (perOrder !== undefined) limits.per_order_limit_cents = perOrder;
  if (perMonth !== undefined) limits.per_month_limit_cents = perMonth;
  if (threshold !== undefined) limits.approval_threshold_cents = threshold;
  limits.per_day_limit_cents = Math.min(limits.per_day_limit_cents, limits.per_month_limit_cents);
  const token = `mv_bot_${randomToken(32)}`;
  const id = newId("bot");
  transaction((db) => {
    const categories = many<{ category: string }>(db, `SELECT DISTINCT category FROM products ORDER BY category`).map((r) => r.category);
    run(
      db,
      `INSERT INTO bots (id, user_id, name, token_hash, public_key_pem, mcp_only, scopes, per_order_limit_cents, per_day_limit_cents,
        per_month_limit_cents, approval_threshold_cents, allowed_categories, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id, userId, name, sha256(token), publicKey, mcpOnly ? 1 : 0, JSON.stringify(scopes),
      limits.per_order_limit_cents, limits.per_day_limit_cents, limits.per_month_limit_cents, limits.approval_threshold_cents,
      JSON.stringify(categories), nowIso(),
    );
  });
  // The plain token is returned once and never stored.
  return { id, name, token, scopes, ...limits, mcp_only: mcpOnly, signatures: publicKey ? "registered" : "none" };
}

export function listBots(userId: string) {
  return many<{ id: string; name: string; scopes: string; revoked_at: string | null; per_order_limit_cents: number; per_month_limit_cents: number; approval_threshold_cents: number; created_at: string; has_key: number; mcp_only: number }>(
    getDb(),
    `SELECT id, name, scopes, revoked_at, per_order_limit_cents, per_month_limit_cents, approval_threshold_cents, created_at,
       (public_key_pem IS NOT NULL) AS has_key, mcp_only FROM bots WHERE user_id = ? ORDER BY created_at DESC`,
    userId,
  ).map((b) => ({
    ...b,
    scopes: JSON.parse(b.scopes) as string[],
    has_key: Boolean(b.has_key),
    mcp_only: Boolean(b.mcp_only),
    // Legacy bots made before keys were required: flagged until a key is added.
    needs_key: !b.has_key && !b.mcp_only,
  }));
}

// ---------- addresses ----------

export type Address = {
  id: string; label: string; recipient: string; line1: string; line2: string | null;
  city: string; region: string; postal_code: string; country: string; is_default: boolean;
};

const ADDRESS_FIELDS = ["label", "recipient", "line1", "line2", "city", "region", "postal_code", "country"] as const;

function cleanAddress(input: Record<string, unknown>, partial: boolean) {
  const out: Record<string, string | null> = {};
  for (const f of ADDRESS_FIELDS) {
    if (input[f] === undefined) continue;
    const v = input[f] === null ? null : String(input[f]).trim().slice(0, 200);
    out[f] = f === "line2" ? v || null : v;
  }
  if (out.country !== undefined) out.country = (out.country || "US").toUpperCase();
  if (out.country && out.country !== "US") throw new ApiError(422, "unsupported_country", "Only US addresses are supported right now.");
  if (!partial) {
    out.label = out.label || "Home";
    out.country = out.country || "US";
  }
  for (const f of ["recipient", "line1", "city", "region", "postal_code"] as const) {
    if ((!partial || f in out) && !out[f]) throw new ApiError(422, "invalid_address", `${f} is required.`);
  }
  return out;
}

function mapAddress(row: Omit<Address, "is_default"> & { is_default: number }): Address {
  return { ...row, is_default: Boolean(row.is_default) };
}

export function listAddresses(userId: string, db: DatabaseSync = getDb()): Address[] {
  return many<Omit<Address, "is_default"> & { is_default: number }>(
    db,
    `SELECT id, label, recipient, line1, line2, city, region, postal_code, country, is_default FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id`,
    userId,
  ).map(mapAddress);
}

function ownedAddress(db: DatabaseSync, userId: string, id: string) {
  const row = one<{ id: string; is_default: number }>(db, `SELECT id, is_default FROM addresses WHERE id = ? AND user_id = ?`, id, userId);
  if (!row) throw new ApiError(404, "not_found", "Address not found.");
  return row;
}

export function createAddress(userId: string, input: Record<string, unknown>): Address {
  const a = cleanAddress(input, false);
  const id = newId("adr");
  return transaction((db) => {
    const hasAny = Boolean(one(db, `SELECT id FROM addresses WHERE user_id = ? LIMIT 1`, userId));
    const makeDefault = !hasAny || input.is_default === true;
    if (makeDefault) run(db, `UPDATE addresses SET is_default = 0 WHERE user_id = ?`, userId);
    run(
      db,
      `INSERT INTO addresses (id, user_id, label, recipient, line1, line2, city, region, postal_code, country, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, userId, a.label, a.recipient, a.line1, a.line2 ?? null, a.city, a.region, a.postal_code, a.country, makeDefault ? 1 : 0,
    );
    return listAddresses(userId, db).find((x) => x.id === id)!;
  });
}

export function updateAddress(userId: string, id: string, input: Record<string, unknown>): Address {
  const a = cleanAddress(input, true);
  return transaction((db) => {
    ownedAddress(db, userId, id);
    for (const [k, v] of Object.entries(a)) run(db, `UPDATE addresses SET ${k} = ? WHERE id = ?`, v, id);
    if (input.is_default === true) {
      run(db, `UPDATE addresses SET is_default = 0 WHERE user_id = ?`, userId);
      run(db, `UPDATE addresses SET is_default = 1 WHERE id = ?`, id);
    }
    return listAddresses(userId, db).find((x) => x.id === id)!;
  });
}

export function deleteAddress(userId: string, id: string): void {
  transaction((db) => {
    const row = ownedAddress(db, userId, id);
    run(db, `DELETE FROM addresses WHERE id = ?`, id);
    if (row.is_default) {
      const next = one<{ id: string }>(db, `SELECT id FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1`, userId);
      if (next) run(db, `UPDATE addresses SET is_default = 1 WHERE id = ?`, next.id);
    }
  });
}
