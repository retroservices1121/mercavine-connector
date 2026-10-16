#!/usr/bin/env node
// Decrypt a Mercavine backup (.sqlite.gz.enc) into a plain SQLite file.
// Usage: BACKUP_ENCRYPTION_KEY=... node scripts/restore-backup.mjs <backup.sqlite.gz.enc> <out.sqlite>
// The key is read from the environment so it never lands in shell history.
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: BACKUP_ENCRYPTION_KEY=... node scripts/restore-backup.mjs <in.sqlite.gz.enc> <out.sqlite>");
  process.exit(2);
}
if (existsSync(output)) {
  console.error(`Refusing to overwrite ${output}.`);
  process.exit(2);
}
const raw = (process.env.BACKUP_ENCRYPTION_KEY || "").trim();
const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
if (key.length !== 32) {
  console.error("BACKUP_ENCRYPTION_KEY must be set and decode to 32 bytes.");
  process.exit(2);
}
const blob = readFileSync(input);
if (blob.subarray(0, 5).toString() !== "MVBK1") {
  console.error("Not a Mercavine backup file.");
  process.exit(1);
}
const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(5, 17));
decipher.setAuthTag(blob.subarray(17, 33));
const plain = gunzipSync(Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]));
writeFileSync(output, plain, { mode: 0o600 });
console.log(`Restored ${plain.length} bytes to ${output}. Check it with: sqlite3 ${output} "PRAGMA integrity_check;"`);
