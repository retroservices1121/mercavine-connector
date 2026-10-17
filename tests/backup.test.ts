import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupConfig, decryptBackup, encryptBackup, runBackup, signS3Put, snapshotDatabase } from "../src/lib/backup";
import { getDb } from "../src/lib/db";
import { useTempDb } from "./db";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const env = {
  BACKUP_S3_ENDPOINT: "https://s3.example.test",
  BACKUP_S3_BUCKET: "mv-backups",
  BACKUP_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  BACKUP_S3_SECRET_ACCESS_KEY: "test-secret",
  BACKUP_ENCRYPTION_KEY: KEY_B64,
};

describe("nightly backups", () => {
  useTempDb();
  afterEach(() => vi.restoreAllMocks());

  it("is inert when env vars are unset", async () => {
    expect(backupConfig({})).toBeNull();
    expect(backupConfig({ ...env, BACKUP_ENCRYPTION_KEY: "short" })).toBeNull();
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await runBackup(null)).toEqual({ ok: false, skipped: "not_configured" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("snapshots, encrypts, and round-trips to a valid database", () => {
    const snap = snapshotDatabase(getDb());
    const blob = encryptBackup(snap, Buffer.alloc(32, 7));
    expect(blob.includes(Buffer.from("SQLite format 3"))).toBe(false);
    const plain = decryptBackup(blob, Buffer.alloc(32, 7));
    const dir = mkdtempSync(join(tmpdir(), "mv-restore-"));
    writeFileSync(join(dir, "r.sqlite"), plain);
    const db = new DatabaseSync(join(dir, "r.sqlite"));
    expect((db.prepare(`PRAGMA integrity_check`).get() as Record<string, string>).integrity_check).toBe("ok");
    db.close();
    expect(() => decryptBackup(blob, Buffer.alloc(32, 8))).toThrow();
  });

  it("the restore script decrypts a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "mv-restore-"));
    const blob = encryptBackup(snapshotDatabase(getDb()), Buffer.alloc(32, 7));
    writeFileSync(join(dir, "b.enc"), blob);
    execFileSync(process.execPath, ["scripts/restore-backup.mjs", join(dir, "b.enc"), join(dir, "out.sqlite")], {
      env: { ...process.env, BACKUP_ENCRYPTION_KEY: KEY_B64 },
      stdio: "pipe",
    });
    expect(readFileSync(join(dir, "out.sqlite")).subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  it("uploads with a SigV4-signed PUT", async () => {
    const cfg = backupConfig(env)!;
    const signed = signS3Put(cfg, "mercavine/x.enc", Buffer.from("abc"), new Date("2026-10-17T07:00:00Z"));
    expect(signed.url).toBe("https://s3.example.test/mv-backups/mercavine/x.enc");
    expect(signed.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261017\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const result = await runBackup(cfg);
    expect(result.ok).toBe(true);
    expect(spy.mock.calls[0][1]?.method).toBe("PUT");
  });
});
