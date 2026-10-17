import type { DatabaseSync } from "node:sqlite";
import { MIN_PASSWORD_LENGTH } from "./accounts";
import { addHours, now, nowIso } from "./clock";
import { config } from "./config";
import { getDb, transaction } from "./db";
import { ApiError } from "./errors";
import { newId, randomToken, sha256 } from "./ids";
import { sendMail } from "./mailer";
import { hashPassword } from "./password";
import { one, run } from "./sql";

export const VERIFY_TTL_HOURS = 24;
export const RESET_TTL_HOURS = 1;
export const UNLOCK_TTL_HOURS = 24;
type Purpose = "verify" | "reset" | "unlock";

function siteUrl(): string {
  const base = process.env.MAIL_LINK_BASE_URL?.trim() || `https://${config().brandDomain}`;
  return base.replace(/\/$/, "");
}

function issue(db: DatabaseSync, userId: string, purpose: Purpose, ttlHours: number): string {
  const token = randomToken(32);
  run(
    db,
    `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    newId("etk"), userId, purpose, sha256(token), addHours(now(), ttlHours), nowIso(),
  );
  return token;
}

/** Marks a token used and returns its user, or throws a generic invalid-link error. */
function consume(db: DatabaseSync, token: string, purpose: Purpose): string {
  const row = one<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    db,
    `SELECT id, user_id, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?`,
    sha256(String(token ?? "")), purpose,
  );
  if (!row || row.used_at || row.expires_at <= nowIso()) {
    throw new ApiError(400, "invalid_token", "This link is invalid or has expired.");
  }
  run(db, `UPDATE email_tokens SET used_at = ? WHERE id = ?`, nowIso(), row.id);
  return row.user_id;
}

// ---------- rate limits (in-memory, per instance) ----------

const buckets = new Map<string, { count: number; reset: number }>();
export function limit(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t > b.reset) {
    b = { count: 0, reset: t + windowMs };
    buckets.set(key, b);
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}
export function resetEmailRateLimits() {
  buckets.clear();
}
const HOUR = 3_600_000;

// ---------- verification ----------

export async function sendVerification(userId: string): Promise<void> {
  const user = one<{ email: string; email_verified: number }>(getDb(), `SELECT email, email_verified FROM users WHERE id = ?`, userId);
  if (!user || user.email_verified) return;
  const token = transaction((db) => issue(db, userId, "verify", VERIFY_TTL_HOURS));
  const link = `${siteUrl()}/verify?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    tag: "verify_email",
    subject: "Verify your Mercavine email",
    text: `Confirm your email to start checking out with Mercavine:\n\n${link}\n\nThis link works once and expires in ${VERIFY_TTL_HOURS} hours. If you did not sign up, ignore this email.`,
  });
}

export async function resendVerification(userId: string): Promise<void> {
  if (!limit(`verify:${userId}`, 3, HOUR)) {
    throw new ApiError(429, "rate_limited", "Too many verification emails. Try again later.");
  }
  await sendVerification(userId);
}

export function verifyEmail(token: string): { user_id: string } {
  return transaction((db) => {
    const userId = consume(db, token, "verify");
    run(db, `UPDATE users SET email_verified = 1 WHERE id = ?`, userId);
    run(db, `UPDATE email_tokens SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND purpose = 'verify'`, nowIso(), userId);
    return { user_id: userId };
  });
}

export function isEmailVerified(userId: string, db: DatabaseSync = getDb()): boolean {
  const row = one<{ email_verified: number }>(db, `SELECT email_verified FROM users WHERE id = ?`, userId);
  return Boolean(row?.email_verified);
}

export function assertEmailVerified(userId: string, db: DatabaseSync = getDb()): void {
  if (!isEmailVerified(userId, db)) {
    throw new ApiError(403, "email_unverified", "The shopper must verify their email before checkout. Ask them to open the link we emailed or resend it from their account.");
  }
}

// ---------- password reset ----------

export async function forgotPassword(emailInput: unknown, ip: string): Promise<void> {
  const email = String(emailInput ?? "").trim().toLowerCase();
  const ipOk = limit(`forgot-ip:${ip}`, 10, HOUR);
  const emailOk = email ? limit(`forgot-email:${email}`, 3, HOUR) : false;
  if (!ipOk || !emailOk) return; // silent: response stays generic
  const user = one<{ id: string; email: string }>(getDb(), `SELECT id, email FROM users WHERE email = ?`, email);
  if (!user) return;
  const token = transaction((db) => issue(db, user.id, "reset", RESET_TTL_HOURS));
  const link = `${siteUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    tag: "password_reset",
    subject: "Reset your Mercavine password",
    text: `Someone asked to reset your Mercavine password. To choose a new one, open:\n\n${link}\n\nThis link works once and expires in ${RESET_TTL_HOURS} hour. If it was not you, ignore this email; your password is unchanged.`,
  });
}

export function resetPassword(token: string, password: unknown): { user_id: string; sessions_revoked: number } {
  const pw = String(password ?? "");
  if (pw.length < MIN_PASSWORD_LENGTH || pw.length > 200) {
    throw new ApiError(422, "weak_password", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return transaction((db) => {
    const userId = consume(db, token, "reset");
    run(db, `UPDATE users SET password_hash = ? WHERE id = ?`, hashPassword(pw), userId);
    run(db, `UPDATE email_tokens SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND purpose = 'reset'`, nowIso(), userId);
    const revoked = Number(db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId).changes);
    // Bot tokens are intentionally left active; the shopper can revoke them at /account/bots.
    return { user_id: userId, sessions_revoked: revoked };
  });
}

// ---------- account unlock (login lockout) ----------

/** Email a one-time link that lifts a login lockout early. */
export async function sendUnlockEmail(userId: string, email: string): Promise<void> {
  try {
    const token = transaction((db) => issue(db, userId, "unlock", UNLOCK_TTL_HOURS));
    const link = `${siteUrl()}/api/v1/session/unlock?token=${encodeURIComponent(token)}`;
    await sendMail({
      to: email,
      tag: "unlock",
      subject: "Your Mercavine sign-in was locked",
      text: `We locked sign-in to your Mercavine account after ${10} failed password attempts.\n\nIf this was you, unlock now: ${link}\nThe lock also lifts on its own in about 30 minutes.\n\nIf this was not you, reset your password at ${siteUrl()}/forgot-password and contact security@mercavine.com.`,
    });
  } catch {
    console.warn("[mailer] unlock email failed");
  }
}

/** Consume an unlock token and clear the account lock. Returns the email that was unlocked. */
export function consumeUnlockToken(token: string): string {
  return transaction((db) => {
    const userId = consume(db, token, "unlock");
    const user = one<{ email: string }>(db, `SELECT email FROM users WHERE id = ?`, userId);
    if (!user) throw new ApiError(400, "invalid_token", "This link is invalid or expired.");
    run(db, `DELETE FROM login_failures WHERE kind = 'account' AND subject = ?`, user.email.toLowerCase());
    return user.email;
  });
}
