import type { DatabaseSync } from "node:sqlite";
import { audit } from "./audit";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { one, run } from "./sql";

/**
 * Persistent login lockout (SP-API DPP: lock after 10 failed attempts).
 * Failures are counted per account (normalized email) and per client IP in
 * SQLite, so they survive restarts and deploys. A lock lifts automatically
 * after LOCKOUT_MINUTES, or immediately through the emailed unlock link.
 */
export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 30);
/** Failures older than this window no longer count toward a lock. */
export const FAILURE_WINDOW_MINUTES = 60;

type Kind = "account" | "ip";
type Row = { failures: number; first_at: number; locked_until: number | null };

export function ensureLockoutSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS login_failures (
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    failures INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    locked_until INTEGER,
    PRIMARY KEY (kind, subject)
  )`);
}

function nowMs(): number {
  return Date.now();
}

function read(db: DatabaseSync, kind: Kind, subject: string): Row | undefined {
  return one<Row>(db, `SELECT failures, first_at, locked_until FROM login_failures WHERE kind = ? AND subject = ?`, kind, subject);
}

function lockedUntil(db: DatabaseSync, kind: Kind, subject: string): number | null {
  const row = read(db, kind, subject);
  if (!row?.locked_until) return null;
  if (row.locked_until <= nowMs()) {
    run(db, `DELETE FROM login_failures WHERE kind = ? AND subject = ?`, kind, subject);
    return null;
  }
  return row.locked_until;
}

/** Throws 429 if the account or IP is currently locked. */
export function assertNotLocked(email: string, ip: string | null, db: DatabaseSync = getDb()): void {
  const until = Math.max(lockedUntil(db, "account", email) ?? 0, ip ? (lockedUntil(db, "ip", ip) ?? 0) : 0);
  if (until > 0) {
    const retry = Math.max(1, Math.ceil((until - nowMs()) / 1000));
    throw new ApiError(
      429,
      "login_locked",
      "Too many failed sign-in attempts. Try again later or use the unlock link we emailed you.",
      { retry_after_seconds: retry },
      { "Retry-After": String(retry) },
    );
  }
}

export type LockEvent = { kind: Kind; subject: string; until: number };

function bump(db: DatabaseSync, kind: Kind, subject: string): LockEvent | null {
  const t = nowMs();
  const row = read(db, kind, subject);
  const windowStart = t - FAILURE_WINDOW_MINUTES * 60_000;
  const failures = row && row.first_at >= windowStart ? row.failures + 1 : 1;
  const firstAt = row && row.first_at >= windowStart ? row.first_at : t;
  const lock = failures >= MAX_FAILED_LOGINS ? t + LOCKOUT_MINUTES * 60_000 : null;
  run(
    db,
    `INSERT INTO login_failures (kind, subject, failures, first_at, last_at, locked_until) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, subject) DO UPDATE SET failures = excluded.failures, first_at = excluded.first_at,
       last_at = excluded.last_at, locked_until = excluded.locked_until`,
    kind,
    subject,
    failures,
    firstAt,
    t,
    lock,
  );
  return lock ? { kind, subject, until: lock } : null;
}

/** Record a failed attempt. Returns the locks that were just applied. */
export function recordFailedLogin(email: string, ip: string | null, db: DatabaseSync = getDb()): LockEvent[] {
  const events: LockEvent[] = [];
  const a = bump(db, "account", email);
  if (a) events.push(a);
  if (ip) {
    const i = bump(db, "ip", ip);
    if (i) events.push(i);
  }
  for (const event of events) {
    audit(db, {
      actorType: "system",
      action: "login.locked",
      resourceType: event.kind,
      resourceId: event.kind === "account" ? event.subject : null,
      detail: { until: new Date(event.until).toISOString(), failures: MAX_FAILED_LOGINS },
    });
    console.warn(`[security-alert] login lockout kind=${event.kind} until=${new Date(event.until).toISOString()}`);
  }
  return events;
}

/** Successful sign-in clears the account counter (the IP counter decays on its own). */
export function clearAccountFailures(email: string, db: DatabaseSync = getDb()): void {
  run(db, `DELETE FROM login_failures WHERE kind = 'account' AND subject = ?`, email);
}

export function resetLockouts(db: DatabaseSync = getDb()): void {
  run(db, `DELETE FROM login_failures`);
}
