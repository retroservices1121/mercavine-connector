import type { DatabaseSync } from "node:sqlite";
import { audit } from "./audit";
import { addDays, now, nowIso } from "./clock";
import { getDb, transaction } from "./db";
import { ApiError } from "./errors";
import { sendMail } from "./mailer";
import { verifyPassword } from "./password";
import { ACCOUNT_DATA_RETENTION_DAYS, PRIVACY_EMAIL } from "./privacy-content";
import { many, one, run } from "./sql";

/**
 * Self-serve account deletion (SP-API DPP / privacy policy: delete within 30 days).
 *
 * Request: the account is deactivated at once (sessions dropped, bots revoked,
 * password disabled) and stamped with deletion_requested_at.
 * Purge: a daily job hard-deletes personal data for requests older than
 * PURGE_AFTER_DAYS. That is one day under the 30-day promise so a once-a-day
 * job always finishes inside 30 days. Orders, returns and the spend ledger are
 * kept (tax/accounting) but detached from any personal data: the user row is
 * anonymized and the addresses are deleted.
 */
export const PURGE_AFTER_DAYS = ACCOUNT_DATA_RETENTION_DAYS - 1;
const DISABLED_PREFIX = "deletion-pending|";

export function ensureDeletionSchema(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "deletion_requested_at")) db.exec(`ALTER TABLE users ADD COLUMN deletion_requested_at TEXT`);
  if (!cols.some((c) => c.name === "deleted_at")) db.exec(`ALTER TABLE users ADD COLUMN deleted_at TEXT`);
}

export async function requestAccountDeletion(userId: string, password: string): Promise<{ purge_after: string }> {
  const { email, purgeAfter } = transaction((db) => {
    const user = one<{ email: string; password_hash: string; deletion_requested_at: string | null }>(
      db,
      `SELECT email, password_hash, deletion_requested_at FROM users WHERE id = ?`,
      userId,
    );
    if (!user) throw new ApiError(404, "not_found", "Account not found.");
    if (!verifyPassword(password, user.password_hash)) throw new ApiError(401, "invalid_password", "Password is wrong.");
    const seller = one<{ id: string }>(db, `SELECT id FROM sellers WHERE user_id = ? LIMIT 1`, userId);
    if (seller) {
      throw new ApiError(409, "seller_account", `Seller accounts have payouts to settle. Email ${PRIVACY_EMAIL} to delete this account.`);
    }
    const at = nowIso();
    run(db, `UPDATE users SET deletion_requested_at = ?, password_hash = ? WHERE id = ?`, at, DISABLED_PREFIX + user.password_hash, userId);
    run(db, `DELETE FROM sessions WHERE user_id = ?`, userId);
    run(db, `UPDATE bots SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?`, at, userId);
    run(db, `UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE bot_id IN (SELECT id FROM bots WHERE user_id = ?)`, at, userId);
    audit(db, { actorType: "human", actorId: userId, action: "account.deletion_requested", resourceType: "user", resourceId: userId });
    return { email: user.email, purgeAfter: addDays(now(), PURGE_AFTER_DAYS) };
  });
  await sendMail({
    to: email,
    tag: "account-deletion",
    subject: "Your Mercavine account is scheduled for deletion",
    text: `We received your request to delete your Mercavine account. It is now deactivated, and your personal data will be permanently deleted within ${ACCOUNT_DATA_RETENTION_DAYS} days.\n\nIf you did not ask for this, email ${PRIVACY_EMAIL} right away.`,
  });
  return { purge_after: purgeAfter };
}

/** Hard-delete personal data for one user, keeping anonymized financial records. */
function purgeUser(db: DatabaseSync, userId: string): void {
  const bots = many<{ id: string }>(db, `SELECT id FROM bots WHERE user_id = ?`, userId).map((b) => b.id);
  const inBots = bots.length ? `(${bots.map(() => "?").join(",")})` : "(NULL)";
  const byUser: string[] = [
    "sessions", "addresses", "webauthn_credentials", "webauthn_challenges", "shop_links", "email_tokens",
    "notifications", "auto_rules", "oauth_requests", "oauth_codes", "approval_tokens", "shop_pay_requests",
  ];
  for (const table of byUser) run(db, `DELETE FROM ${table} WHERE user_id = ?`, userId);
  run(db, `DELETE FROM oauth_tokens WHERE bot_id IN ${inBots}`, ...bots);
  run(db, `DELETE FROM idempotency_keys WHERE bot_client_id IN ${inBots}`, ...bots);
  // Bots stay (orders/carts reference them) but lose their names, keys and token hashes.
  run(
    db,
    `UPDATE bots SET name = 'Deleted bot', public_key_pem = NULL, token_hash = 'deleted:' || id, revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?`,
    nowIso(),
    userId,
  );
  run(db, `UPDATE carts SET note_for_human = NULL, client_reference = NULL, decline_note = NULL, shipping_address_id = NULL WHERE user_id = ?`, userId);
  run(
    db,
    `UPDATE users SET email = 'deleted+' || id || '@invalid.mercavine', name = 'Deleted user', display_name = 'Deleted user',
       password_hash = '', deleted_at = ? WHERE id = ?`,
    nowIso(),
    userId,
  );
  audit(db, { actorType: "system", action: "account.purged", resourceType: "user", resourceId: userId });
}

/** Expired credentials and one-time tokens are useless and are deleted. */
function purgeExpiredTokens(db: DatabaseSync): Record<string, number> {
  const at = nowIso();
  const cutoff = addDays(now(), -1);
  const out: Record<string, number> = {};
  const del = (table: string, where: string, ...args: string[]) => {
    out[table] = Number(db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes);
  };
  del("sessions", "expires_at < ?", at);
  del("email_tokens", "expires_at < ?", cutoff);
  del("webauthn_challenges", "expires_at < ?", cutoff);
  del("oauth_requests", "expires_at < ?", cutoff);
  del("oauth_codes", "expires_at < ?", cutoff);
  del("oauth_tokens", "expires_at < ?", cutoff);
  return out;
}

export function runPrivacyPurge(db: DatabaseSync = getDb()): { users: number; expired: Record<string, number> } {
  const due = addDays(now(), -PURGE_AFTER_DAYS);
  db.exec("BEGIN IMMEDIATE");
  try {
    const users = many<{ id: string }>(
      db,
      `SELECT id FROM users WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL AND deletion_requested_at <= ?`,
      due,
    );
    for (const u of users) purgeUser(db, u.id);
    const expired = purgeExpiredTokens(db);
    db.exec("COMMIT");
    if (users.length) console.log(`[mercavine] privacy purge: deleted ${users.length} account(s)`);
    return { users: users.length, expired };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Run once shortly after boot and then every 24 hours. */
export function schedulePrivacyPurge(): void {
  const tick = () => {
    try {
      runPrivacyPurge();
    } catch (error) {
      console.error("[mercavine] privacy purge failed", error instanceof Error ? error.message : "error");
    }
  };
  setTimeout(tick, 5 * 60_000).unref?.();
  setInterval(tick, 24 * 60 * 60_000).unref?.();
}
