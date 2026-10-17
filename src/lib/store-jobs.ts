/**
 * Scheduled Mercavine Store jobs (single Railway instance, in-process):
 *   cj-sync      catalog import + reprice   CJ_SYNC_INTERVAL_MIN     (default 360)
 *   cj-refresh   price/stock refresh        CJ_REFRESH_INTERVAL_MIN  (default 60)
 *   cj-tracking  CJ tracking -> shipped     CJ_TRACKING_INTERVAL_MIN (default 60)
 *   tax-commit   retry failed Stripe Tax transaction records (every tracking tick)
 * Off unless MERCAVINE_STORE_ENABLED=true and CJ_API_KEY is set; STORE_JOBS_ENABLED=false forces off.
 * An interval of 0 disables that job. Overlap is prevented by an in-process flag plus a lease row in
 * `settings` (job_lock:<name>), so a second process or a slow run can't double-run a job.
 * Pricing rules (20% margin, $15 minimum, US-warehouse stock) live in cj-store.ts and apply unchanged.
 */
import { nowIso } from "./clock";
import { getDb } from "./db";
import { many, one, run } from "./sql";

const running = new Set<string>();

export function jobsConfig() {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const storeOn = process.env.MERCAVINE_STORE_ENABLED === "true";
  const cjOn = Boolean(process.env.CJ_API_KEY?.trim());
  return {
    enabled: storeOn && cjOn && process.env.STORE_JOBS_ENABLED !== "false",
    syncMin: n(process.env.CJ_SYNC_INTERVAL_MIN, 360),
    refreshMin: n(process.env.CJ_REFRESH_INTERVAL_MIN, 60),
    trackingMin: n(process.env.CJ_TRACKING_INTERVAL_MIN, 60),
    syncMaxNew: n(process.env.CJ_SYNC_MAX_NEW, 25),
    refreshLimit: n(process.env.CJ_REFRESH_LIMIT, 100),
  };
}

/** Take the lease for `name` for `ttlMs`. Returns false if another holder's lease is still valid. */
export function acquireLock(name: string, ttlMs: number, now = Date.now()): boolean {
  const db = getDb();
  const key = `job_lock:${name}`;
  const res = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < ?`,
  ).run(key, String(now + ttlMs), now);
  return res.changes === 1;
}
export function releaseLock(name: string) {
  run(getDb(), `DELETE FROM settings WHERE key = ?`, `job_lock:${name}`);
}

/** Run `fn` under the in-process flag and DB lease. Returns null when skipped because it's already running. */
export async function runJob<T>(name: string, fn: () => Promise<T>, ttlMs = 30 * 60_000): Promise<T | null> {
  if (running.has(name)) return null;
  if (!acquireLock(name, ttlMs)) return null;
  running.add(name);
  const started = Date.now();
  try {
    const out = await fn();
    run(getDb(), `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `job_last:${name}`, JSON.stringify({ at: nowIso(), ok: true, ms: Date.now() - started, result: out }));
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : "error";
    console.error(`[store-jobs] ${name} failed: ${msg}`);
    run(getDb(), `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `job_last:${name}`, JSON.stringify({ at: nowIso(), ok: false, error: msg }));
    return null;
  } finally {
    running.delete(name);
    releaseLock(name);
  }
}

export function jobStatus(): Record<string, unknown> {
  const rows = many<{ key: string; value: string }>(getDb(), `SELECT key, value FROM settings WHERE key LIKE 'job_last:%'`);
  const out: Record<string, unknown> = {};
  for (const r of rows) { try { out[r.key.slice(9)] = JSON.parse(r.value); } catch { /* ignore */ } }
  return out;
}

/** Retry Stripe Tax transaction records that failed right after capture. */
export async function retryTaxCommits(): Promise<{ retried: number; committed: number }> {
  const rows = many<{ cart_id: string }>(getDb(),
    `SELECT cart_id FROM tax_quotes WHERE calculation_id IS NOT NULL AND transaction_id IS NULL AND order_id IS NOT NULL LIMIT 50`);
  const { commitTaxFor } = await import("./cj-store");
  let committed = 0;
  for (const r of rows) if (await commitTaxFor(r.cart_id)) committed++;
  return { retried: rows.length, committed };
}

export const jobs: Record<"cj-sync" | "cj-refresh" | "cj-tracking" | "tax-commit", () => Promise<unknown>> = {
  "cj-sync": async () => (await import("./cj-store")).syncCatalog({ maxNew: jobsConfig().syncMaxNew }),
  "cj-refresh": async () => (await import("./cj-store")).refreshAll(jobsConfig().refreshLimit),
  "cj-tracking": async () => (await import("./cj-store")).syncTracking(),
  "tax-commit": retryTaxCommits,
};

let scheduled = false;
export function scheduleStoreJobs(): void {
  const cfg = jobsConfig();
  if (!cfg.enabled) {
    console.log("[store-jobs] off (needs MERCAVINE_STORE_ENABLED=true and CJ_API_KEY).");
    return;
  }
  if (scheduled) return;
  scheduled = true;
  const every = (name: keyof typeof jobs, minutes: number, firstDelayMs: number) => {
    if (minutes <= 0) return;
    const tick = () => { void runJob(name, jobs[name]); };
    setTimeout(tick, firstDelayMs).unref?.();
    setInterval(tick, minutes * 60_000).unref?.();
  };
  every("cj-refresh", cfg.refreshMin, 3 * 60_000);
  every("cj-tracking", cfg.trackingMin, 5 * 60_000);
  every("tax-commit", cfg.trackingMin, 6 * 60_000);
  every("cj-sync", cfg.syncMin, 10 * 60_000);
  console.log(`[store-jobs] on: sync ${cfg.syncMin}m, refresh ${cfg.refreshMin}m, tracking ${cfg.trackingMin}m.`);
}
