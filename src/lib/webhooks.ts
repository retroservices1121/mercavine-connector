import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./clock";
import { enqueueDelivery, getDb } from "./db";
import { newId } from "./ids";
import { one, run } from "./sql";

type KeyPair = { privatePem: string; publicRawB64: string };

const memoryInbox: { url: string; body: string; headers: Record<string, string> }[] = [];

export function memoryWebhooks() {
  return memoryInbox;
}

export function clearMemoryWebhooks() {
  memoryInbox.length = 0;
}

export function webhookKeys(db: DatabaseSync = getDb()): KeyPair {
  const row = one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'webhook_keys'`);
  if (row) return JSON.parse(row.value) as KeyPair;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pair: KeyPair = { privatePem, publicRawB64: der.subarray(der.length - 32).toString("base64") };
  run(db, `INSERT INTO settings (key, value) VALUES ('webhook_keys', ?)`, JSON.stringify(pair));
  return pair;
}

export function webhookPublicJwks() {
  const keys = webhookKeys();
  return { keys: [{ kid: "mv1", alg: "Ed25519", public_key: keys.publicRawB64 }] };
}

export function signWebhook(id: string, timestamp: string, body: string, privatePem?: string): string {
  const pem = privatePem ?? webhookKeys().privatePem;
  const payload = Buffer.from(`${id}.${timestamp}.${body}`);
  return sign(null, payload, createPrivateKey(pem)).toString("base64");
}

export function verifyWebhook(id: string, timestamp: string, body: string, signature: string, publicRawB64?: string): boolean {
  const raw = Buffer.from(publicRawB64 ?? webhookKeys().publicRawB64, "base64");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  const sig = signature.replace(/^v1,/, "");
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  return verify(null, Buffer.from(`${id}.${timestamp}.${body}`), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(sig, "base64"));
}

function matches(pattern: string, type: string): boolean {
  return pattern.split(",").some((item) => {
    const value = item.trim();
    if (value.endsWith(".*")) return type.startsWith(value.slice(0, -1));
    return value === type;
  });
}

export function queueWebhooks(db: DatabaseSync, botId: string | null | undefined, eventId: string, type: string, body: unknown) {
  if (!botId) return;
  const hooks = manyEndpoints(db, botId);
  const encoded = JSON.stringify(body);
  for (const hook of hooks) {
    if (hook.disabled_at) continue;
    if (!matches(hook.events, type)) continue;
    const id = newId("whd");
    run(
      db,
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, body, status, attempts, next_attempt_at, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, ?)`,
      id,
      hook.id,
      eventId,
      type,
      encoded,
      nowIso(),
      nowIso(),
    );
    enqueueDelivery(id);
  }
}

function manyEndpoints(db: DatabaseSync, botId: string) {
  return db
    .prepare(`SELECT id, url, events, disabled_at FROM webhook_endpoints WHERE bot_client_id = ?`)
    .all(botId) as unknown as { id: string; url: string; events: string; disabled_at: string | null }[];
}

export async function attemptDelivery(deliveryId: string): Promise<void> {
  const db = getDb();
  const row = one<{
    id: string;
    endpoint_id: string;
    body: string;
    attempts: number;
    url: string;
    disabled_at: string | null;
    failure_since: string | null;
  }>(
    db,
    `SELECT d.id, d.endpoint_id, d.body, d.attempts, e.url, e.disabled_at, e.failure_since
     FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = ?`,
    deliveryId,
  );
  if (!row || row.disabled_at) return;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhook(deliveryId, timestamp, row.body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "webhook-id": deliveryId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
  if (row.url.startsWith("memory:")) {
    memoryInbox.push({ url: row.url, body: row.body, headers });
    run(db, `UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1 WHERE id = ?`, deliveryId);
    return;
  }
  try {
    const response = await fetch(row.url, { method: "POST", headers, body: row.body, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    run(db, `UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL WHERE id = ?`, deliveryId);
    run(db, `UPDATE webhook_endpoints SET failure_since = NULL WHERE id = ?`, row.endpoint_id);
  } catch (error) {
    const attempts = row.attempts + 1;
    const delaySec = Math.min(3600, 30 * 2 ** Math.min(attempts, 8));
    const next = new Date(Date.now() + delaySec * 1000).toISOString();
    const since = row.failure_since ?? nowIso();
    const dead = Date.now() - Date.parse(since) > 3 * 24 * 3600 * 1000;
    run(
      db,
      `UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
      dead ? "failed" : "retry",
      attempts,
      next,
      error instanceof Error ? error.message : "delivery failed",
      deliveryId,
    );
    run(
      db,
      `UPDATE webhook_endpoints SET failure_since = ?, disabled_at = ? WHERE id = ?`,
      since,
      dead ? nowIso() : null,
      row.endpoint_id,
    );
  }
}

export function retryDueWebhooks() {
  const db = getDb();
  const due = db
    .prepare(`SELECT id FROM webhook_deliveries WHERE status = 'retry' AND next_attempt_at <= ? LIMIT 20`)
    .all(nowIso()) as unknown as { id: string }[];
  for (const row of due) void attemptDelivery(row.id);
}
