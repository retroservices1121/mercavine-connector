import type { DatabaseSync } from "node:sqlite";
import { config } from "./config";
import { addHours, nowIso } from "./clock";
import { getDb, transaction } from "./db";
import { ApiError } from "./errors";
import { newId, randomToken, sha256 } from "./ids";
import { verifyPassword } from "./password";
import { verifyBotSignature } from "./signatures";
import { one, run } from "./sql";

export type BotRecord = {
  id: string;
  user_id: string;
  name: string;
  public_key_pem: string | null;
  scopes: string[];
  per_order_limit_cents: number;
  per_day_limit_cents: number;
  per_month_limit_cents: number;
  approval_threshold_cents: number;
  allowed_categories: string[];
  revoked_at: string | null;
};

type BotRow = Omit<BotRecord, "scopes" | "allowed_categories"> & { scopes: string; allowed_categories: string };

const buckets = new Map<string, { tokens: number; reset: number }>();

export function rateLimit(botId: string) {
  const limit = 120;
  const now = Date.now();
  let bucket = buckets.get(botId);
  if (!bucket || now > bucket.reset) {
    bucket = { tokens: limit, reset: now + 60_000 };
    buckets.set(botId, bucket);
  }
  if (bucket.tokens <= 0) {
    const retry = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    throw new ApiError(429, "rate_limited", "Rate limit exceeded for this bot.", { limit: "120_per_minute" }, { "Retry-After": String(retry) });
  }
  bucket.tokens -= 1;
}

export function resetRateLimits() {
  buckets.clear();
}

function mapBot(row: BotRow): BotRecord {
  return { ...row, scopes: JSON.parse(row.scopes) as string[], allowed_categories: JSON.parse(row.allowed_categories) as string[] };
}

export function botByToken(token: string, db: DatabaseSync = getDb()): BotRecord | undefined {
  const row = one<BotRow>(db, `SELECT id, user_id, name, public_key_pem, scopes, per_order_limit_cents, per_day_limit_cents, per_month_limit_cents, approval_threshold_cents, allowed_categories, revoked_at FROM bots WHERE token_hash = ?`, sha256(token));
  return row ? mapBot(row) : undefined;
}

export function botById(id: string, db: DatabaseSync = getDb()): BotRecord | undefined {
  const row = one<BotRow>(db, `SELECT id, user_id, name, public_key_pem, scopes, per_order_limit_cents, per_day_limit_cents, per_month_limit_cents, approval_threshold_cents, allowed_categories, revoked_at FROM bots WHERE id = ?`, id);
  return row ? mapBot(row) : undefined;
}

export async function requireBot(req: Request, rawBody: string, scope: string): Promise<BotRecord> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new ApiError(401, "unauthorized", "Missing bearer token.");
  const bot = botByToken(token);
  if (!bot) throw new ApiError(401, "unauthorized", "Unknown bot token.");
  if (bot.revoked_at) throw new ApiError(401, "bot_revoked", "This bot was revoked.");
  if (!bot.scopes.includes(scope)) {
    throw new ApiError(403, "scope_missing", `This bot is missing the ${scope} scope.`, { scope });
  }
  rateLimit(bot.id);
  const hasSignature = Boolean(req.headers.get("signature") || req.headers.get("signature-input"));
  if (config().requireSignatures || hasSignature) await verifyBotSignature(req, rawBody, bot);
  return bot;
}

/** "buyer" = shopper account; "seller" = separate seller login. The two never share a session or data. */
export type AccountType = "buyer" | "seller";
export type SessionUser = { id: string; email: string; name: string; display_name: string; account_type: AccountType };

export function userById(id: string, db: DatabaseSync = getDb()): SessionUser | undefined {
  return one<SessionUser>(db, `SELECT id, email, name, display_name, account_type FROM users WHERE id = ?`, id);
}

export function login(email: string, password: string): { token: string; user: SessionUser } {
  const db = getDb();
  const row = one<SessionUser & { password_hash: string }>(db, `SELECT id, email, name, display_name, account_type, password_hash FROM users WHERE email = ?`, email.trim().toLowerCase());
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new ApiError(401, "invalid_login", "Email or password is wrong.");
  }
  const token = randomToken(32);
  run(
    db,
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    newId("ses"),
    row.id,
    sha256(token),
    addHours(new Date(), 24 * 14),
    nowIso(),
  );
  return { token, user: { id: row.id, email: row.email, name: row.name, display_name: row.display_name, account_type: row.account_type } };
}

export function userFromSessionToken(token: string | undefined | null): SessionUser | undefined {
  if (!token) return undefined;
  const row = one<SessionUser & { expires_at: string }>(
    getDb(),
    `SELECT u.id, u.email, u.name, u.display_name, u.account_type, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row || row.expires_at < nowIso()) return undefined;
  return { id: row.id, email: row.email, name: row.name, display_name: row.display_name, account_type: row.account_type };
}

export function logout(token: string) {
  run(getDb(), `DELETE FROM sessions WHERE token_hash = ?`, sha256(token));
}

export function sessionCookie(token: string): string {
  const secure = config().publicBaseUrl.startsWith("https:");
  return `mv_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return "mv_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
}

export function readCookie(req: Request, name: string): string {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function requireUser(req: Request): SessionUser {
  const user = userFromSessionToken(readCookie(req, "mv_session"));
  if (!user) throw new ApiError(401, "login_required", "Sign in to continue.");
  return user;
}

/** Shopper-only routes. A seller session gets the same answer as no session, so nothing about the buyer side leaks. */
export function requireBuyer(req: Request): SessionUser {
  const user = requireUser(req);
  if (user.account_type !== "buyer") throw new ApiError(401, "login_required", "Sign in with your shopping account to continue.");
  return user;
}

/** Seller-only routes. A shopper session never sees seller data, even if the same person also has a seller login. */
export function requireSellerSession(req: Request): SessionUser {
  const user = requireUser(req);
  if (user.account_type !== "seller") throw new ApiError(401, "seller_login_required", "Sign in with your seller account to continue.");
  return user;
}

/** Page helpers: the session user only if it is the right kind of account. */
export function buyerFromSessionToken(token: string | undefined | null): SessionUser | undefined {
  const user = userFromSessionToken(token);
  return user?.account_type === "buyer" ? user : undefined;
}
export function sellerUserFromSessionToken(token: string | undefined | null): SessionUser | undefined {
  const user = userFromSessionToken(token);
  return user?.account_type === "seller" ? user : undefined;
}

export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "bad_origin", "Origin is not valid.");
  }
  const host = req.headers.get("host") ?? "";
  let expected = "";
  try {
    expected = new URL(config().publicBaseUrl).host;
  } catch {
    expected = host;
  }
  if (originHost !== host && originHost !== expected) {
    throw new ApiError(403, "bad_origin", "Cross-origin request rejected.");
  }
}

export function hasPasskey(userId: string, db: DatabaseSync = getDb()): boolean {
  const row = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?`, userId);
  return (row?.n ?? 0) > 0;
}

export function revokeBot(botId: string, actorUserId: string) {
  return transaction((db) => {
    const bot = one<{ id: string; user_id: string }>(db, `SELECT id, user_id FROM bots WHERE id = ?`, botId);
    if (!bot || bot.user_id !== actorUserId) throw new ApiError(404, "not_found", "Bot not found.");
    run(db, `UPDATE bots SET revoked_at = ? WHERE id = ?`, nowIso(), botId);
    // Kill every OAuth access and refresh token issued to this bot connection.
    run(db, `UPDATE oauth_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL`, nowIso(), botId);
    const open = db.prepare(`SELECT id FROM carts WHERE bot_client_id = ? AND status IN ('draft', 'pending_approval')`).all(botId) as unknown as { id: string }[];
    for (const cart of open) {
      run(db, `UPDATE carts SET status = 'cancelled', status_reason = 'bot_revoked', updated_at = ? WHERE id = ?`, nowIso(), cart.id);
      run(db, `UPDATE inventory_reservations SET status = 'released' WHERE cart_id = ? AND status = 'held'`, cart.id);
      run(db, `UPDATE approval_tokens SET revoked_at = ? WHERE cart_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`, nowIso(), cart.id);
    }
    return { cancelled: open.length };
  });
}
