import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors";

/**
 * AES-256-GCM encryption for third-party credentials at rest (Amazon LWA
 * refresh tokens, Shop access tokens and device codes).
 *
 * TOKEN_ENCRYPTION_KEY must be 32 random bytes, as base64 (44 chars) or hex
 * (64 chars). Generate one with: openssl rand -base64 32
 *
 * Stored format: enc:v1:<iv b64url>:<tag b64url>:<ciphertext b64url>
 * Storing a new token without a key fails closed.
 */
const PREFIX = "enc:v1:";

export function isSealed(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function keyFromEnv(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export function tokenEncryptionConfigured(): boolean {
  try {
    return keyFromEnv() !== null;
  } catch {
    return false;
  }
}

function requireKey(): Buffer {
  let key: Buffer | null = null;
  try {
    key = keyFromEnv();
  } catch {
    key = null;
  }
  if (!key) {
    throw new ApiError(503, "token_encryption_unavailable", "Credential storage is not configured on this server.");
  }
  return key;
}

/** Encrypt a credential for storage. Null passes through; already-sealed values are kept as-is. */
export function sealToken(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (isSealed(value)) return value;
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/** Decrypt a stored credential. Legacy plaintext rows are returned unchanged until migrated. */
export function openToken(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isSealed(value)) return value;
  const key = requireKey();
  const [iv, tag, ct] = value.slice(PREFIX.length).split(":");
  if (!iv || !tag || ct === undefined) throw new ApiError(500, "token_corrupt", "A stored credential is unreadable.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

const SEALED_COLUMNS: { table: string; key: string; column: string }[] = [
  { table: "amazon_seller_links", key: "seller_id", column: "refresh_token" },
  { table: "shop_links", key: "user_id", column: "access_token" },
  { table: "shop_links", key: "user_id", column: "device_code" },
];

/**
 * Encrypt any plaintext credentials left from before encryption existed.
 * Runs on startup. Without a key it leaves rows alone and logs a warning.
 */
export function encryptLegacyTokens(db: DatabaseSync): number {
  let pending = 0;
  for (const { table, column } of SEALED_COLUMNS) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != '' AND ${column} NOT LIKE 'enc:v1:%'`)
      .get() as { n: number };
    pending += row.n;
  }
  if (!pending) return 0;
  if (!tokenEncryptionConfigured()) {
    console.warn(`[mercavine] ${pending} stored credential(s) are unencrypted; set TOKEN_ENCRYPTION_KEY to encrypt them.`);
    return 0;
  }
  let done = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { table, key, column } of SEALED_COLUMNS) {
      const rows = db
        .prepare(`SELECT ${key} AS id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != '' AND ${column} NOT LIKE 'enc:v1:%'`)
        .all() as { id: string; v: string }[];
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`);
      for (const row of rows) {
        update.run(sealToken(row.v), row.id);
        done += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`[mercavine] encrypted ${done} legacy credential(s).`);
  return done;
}
