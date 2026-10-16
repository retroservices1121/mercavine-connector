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
  mcp_only: boolean;
  scopes: string[];
  per_order_limit_cents: number;
  per_day_limit_cents: number;
  per_month_limit_cents: number;
  approval_threshold_cents: number;
  allowed_categories: string[];
  revoked_at: string | null;
};

type BotRow = Omit<BotRecord, "scopes" | "allowed_categories" | "mcp_only"> & { scopes: string; allowed_categories: string; mcp_only: number };

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
  return { ...row, mcp_only: Boolean(row.mcp_only), scopes: JSON.parse(row.scopes) as string[], allowed_categories: JSON.parse(row.allowed_categories) as string[] };
}

export function botByToken(token: string, db: DatabaseSync = getDb()): BotRecord | undefined {
  const row = one<BotRow>(db, `SELECT id, user_id, name, public_key_pem, mcp_only, scopes, per_order_limit_cents, per_day_limit_cents, per_month_limit_cents, approval_threshold_cents, allowed_categories, revoked_at FROM bots WHERE token_hash = ?`, sha256(token));
  return row ? mapBot(row) : undefined;
}

export function botById(id: string, db: DatabaseSync = getDb()): BotRecord | undefined {
  const row = one<BotRow>(db, `SELECT id, user_id, name, public_key_pem, mcp_only, scopes, per_order_limit_cents, per_day_limit_cents, per_month_limit_cents, approval_threshold_cents, allowed_categories, revoked_at FROM bots WHERE id = ?`, id);
  return row ? mapBot(row) : undefined;
}

export function botSignaturesEnforced(): boolean {
  const cfg = config();
  if (cfg.requireSignatures) return true;
  return Boolean(cfg.botSignatureEnforceAfter && nowIso() >= new Date(cfg.botSignatureEnforceAfter).toISOString());
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
  // REST bot-connection path only. /mcp authenticates with botByToken and is never signature-gated here.
  if (bot.mcp_only) {
    throw new ApiError(401, "mcp_only_connection", "This bot connection is MCP-only. Use /mcp, or connect a bot with a signing key for the REST API.");
  }
  const hasSignature = Boolean(req.headers.get("signature") || req.headers.get("signature-input"));
  if (botSignaturesEnforced()) {
    if (!bot.public_key_pem) {
      throw new ApiError(401, "signature_key_missing", "This bot has no signing key. Add an Ed25519 public key in Connect your bot.");
    }
    await verifyBotSignature(req, rawBody, bot);
  } else if (hasSignature) {
    await verifyBotSignature(req, rawBody, bot);
  }
  return bot;
}

export type SessionUser = { id: string; email: string; name: string; display_name: string };

export function userById(id: string, db: DatabaseSync = getDb()): SessionUser | undefined {
  return one<SessionUser>(db, `SELECT id, email, name, display_name FROM users WHERE id = ?`, id);
}

export function login(email: string, password: string): { token: string; user: SessionUser } {
  const db = getDb();
  const row = one<SessionUser & { password_hash: string }>(db, `SELECT id, email, name, display_name, password_hash FROM users WHERE email = ?`, email.trim().toLowerCase());
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
  return { token, user: { id: row.id, email: row.email, name: row.name, display_name: row.display_name } };
}

export function userFromSessionToken(token: string | undefined | null): SessionUser | undefined {
  if (!token) return undefined;
  const row = one<SessionUser & { expires_at: string }>(
    getDb(),
    `SELECT u.id, u.email, u.name, u.display_name, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row || row.expires_at < nowIso()) return undefined;
  return { id: row.id, email: row.email, name: row.name, display_name: row.display_name };
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
    const open = db.prepare(`SELECT id FROM carts WHERE bot_client_id = ? AND status IN ('draft', 'pending_approval')`).all(botId) as unknown as { id: string }[];
    for (const cart of open) {
      run(db, `UPDATE carts SET status = 'cancelled', status_reason = 'bot_revoked', updated_at = ? WHERE id = ?`, nowIso(), cart.id);
      run(db, `UPDATE inventory_reservations SET status = 'released' WHERE cart_id = ? AND status = 'held'`, cart.id);
      run(db, `UPDATE approval_tokens SET revoked_at = ? WHERE cart_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`, nowIso(), cart.id);
    }
    return { cancelled: open.length };
  });
}
