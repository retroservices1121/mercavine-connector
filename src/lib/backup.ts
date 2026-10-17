import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";

/**
 * Nightly encrypted SQLite backups to S3-compatible storage (Cloudflare R2,
 * Backblaze B2, AWS S3...). Inert unless every BACKUP_* variable is set.
 *
 *   BACKUP_S3_ENDPOINT           e.g. https://<account>.r2.cloudflarestorage.com
 *   BACKUP_S3_BUCKET             bucket name
 *   BACKUP_S3_REGION             "auto" for R2, else the bucket region (default us-east-1)
 *   BACKUP_S3_ACCESS_KEY_ID      write-only key scoped to that bucket
 *   BACKUP_S3_SECRET_ACCESS_KEY
 *   BACKUP_ENCRYPTION_KEY        32 bytes base64/hex (openssl rand -base64 32), kept OFF the storage provider
 *   BACKUP_S3_PREFIX             optional, default "mercavine/"
 *
 * File format (.sqlite.gz.enc): "MVBK1" | iv(12) | tag(16) | AES-256-GCM(gzip(sqlite)).
 * Restore: see docs/BACKUPS.md and scripts/restore-backup.mjs.
 */
const MAGIC = Buffer.from("MVBK1");

export type BackupConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  key: Buffer;
  prefix: string;
};

export function backupConfig(env: Record<string, string | undefined> = process.env): BackupConfig | null {
  const get = (k: string) => env[k]?.trim() || "";
  const endpoint = get("BACKUP_S3_ENDPOINT");
  const bucket = get("BACKUP_S3_BUCKET");
  const accessKeyId = get("BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = get("BACKUP_S3_SECRET_ACCESS_KEY");
  const rawKey = get("BACKUP_ENCRYPTION_KEY");
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !rawKey) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(rawKey) ? Buffer.from(rawKey, "hex") : Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    console.warn("[backup] BACKUP_ENCRYPTION_KEY must decode to 32 bytes; backups disabled.");
    return null;
  }
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    bucket,
    region: get("BACKUP_S3_REGION") || "us-east-1",
    accessKeyId,
    secretAccessKey,
    key,
    prefix: get("BACKUP_S3_PREFIX") || "mercavine/",
  };
}

export function encryptBackup(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

export function decryptBackup(blob: Buffer, key: Buffer): Buffer {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a Mercavine backup file.");
  const iv = blob.subarray(5, 17);
  const tag = blob.subarray(17, 33);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return gunzipSync(Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]));
}

/** Consistent point-in-time copy of the live database (safe under WAL). */
export function snapshotDatabase(db: DatabaseSync = getDb()): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "mv-backup-"));
  const file = join(dir, "snapshot.sqlite");
  try {
    db.prepare(`VACUUM INTO ?`).run(file);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sha256hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** AWS Signature V4 headers for a path-style S3 PUT. */
export function signS3Put(cfg: BackupConfig, objectKey: string, body: Buffer, at = new Date()) {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${objectKey.split("/").map(encodeURIComponent).join("/")}`);
  const amzDate = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "content-type": "application/octet-stream",
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join("");
  const canonicalRequest = ["PUT", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, day), cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const { host: _host, ...sendHeaders } = headers;
  void _host;
  return {
    url: url.toString(),
    headers: {
      ...sendHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export async function runBackup(cfg: BackupConfig | null = backupConfig()): Promise<{ ok: boolean; key?: string; bytes?: number; skipped?: string }> {
  if (!cfg) return { ok: false, skipped: "not_configured" };
  const blob = encryptBackup(snapshotDatabase(), cfg.key);
  const objectKey = `${cfg.prefix}${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite.gz.enc`;
  const { url, headers } = signS3Put(cfg, objectKey, blob);
  const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(blob), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    console.error(`[backup] upload failed: HTTP ${res.status}`);
    return { ok: false };
  }
  console.log(`[backup] uploaded ${objectKey} (${blob.length} bytes)`);
  return { ok: true, key: objectKey, bytes: blob.length };
}

/** Checks hourly; runs once per UTC day at/after BACKUP_HOUR_UTC (default 07 = 3 AM Eastern). Inert without config. */
export function scheduleBackups(): void {
  if (!backupConfig()) {
    console.log("[backup] BACKUP_* env vars not set; nightly backups are off.");
    return;
  }
  const hour = Number(process.env.BACKUP_HOUR_UTC ?? 7);
  let lastDay = "";
  const tick = () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (day === lastDay || now.getUTCHours() < hour) return;
    lastDay = day;
    runBackup().catch((error) => console.error("[backup] failed", error instanceof Error ? error.message : "error"));
  };
  setInterval(tick, 60 * 60_000).unref?.();
  setTimeout(tick, 60_000).unref?.();
}
