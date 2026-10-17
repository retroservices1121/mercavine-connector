import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/lib/api";
import { setCjTransport } from "../src/lib/cj";
import { acquireLock, jobsConfig, releaseLock, runJob } from "../src/lib/store-jobs";
import { useTempDb } from "./db";
import { fakeCj } from "./cj-fakes";

const ADMIN = "admin-token-placeholder-0123456789";
const BASE = "http://127.0.0.1:4317";

describe("store jobs + admin screen auth", () => {
  useTempDb();
  beforeEach(() => { process.env.MERCAVINE_ADMIN_TOKEN = ADMIN; });
  afterEach(() => {
    setCjTransport(null);
    for (const v of ["CJ_API_KEY", "MERCAVINE_STORE_ENABLED", "MERCAVINE_ADMIN_TOKEN", "STORE_JOBS_ENABLED", "CJ_SYNC_INTERVAL_MIN", "CJ_CATEGORY_IDS", "CJ_SYNC_MAX_PAGES"]) delete process.env[v];
  });

  it("jobs are off unless the store is enabled and CJ is configured", () => {
    expect(jobsConfig().enabled).toBe(false);
    process.env.MERCAVINE_STORE_ENABLED = "true";
    expect(jobsConfig().enabled).toBe(false);
    process.env.CJ_API_KEY = "cj-key-placeholder";
    expect(jobsConfig().enabled).toBe(true);
    process.env.STORE_JOBS_ENABLED = "false";
    expect(jobsConfig().enabled).toBe(false);
    process.env.CJ_SYNC_INTERVAL_MIN = "15";
    expect(jobsConfig().syncMin).toBe(15);
  });

  it("lease lock blocks overlap until released or expired", async () => {
    expect(acquireLock("x", 60_000, 1000)).toBe(true);
    expect(acquireLock("x", 60_000, 2000)).toBe(false);
    expect(acquireLock("x", 60_000, 62_000)).toBe(true);
    releaseLock("x");
    let release!: () => void;
    const slow = runJob("y", () => new Promise<number>((r) => { release = () => r(1); }));
    expect(await runJob("y", async () => 2)).toBeNull();
    release();
    expect(await slow).toBe(1);
    expect(await runJob("y", async () => 3)).toBe(3);
  });

  it("refresh job runs through the admin API and records status", async () => {
    process.env.CJ_API_KEY = "cj-key-placeholder";
    process.env.MERCAVINE_STORE_ENABLED = "true";
    process.env.CJ_CATEGORY_IDS = "c1";
    process.env.CJ_SYNC_MAX_PAGES = "1";
    fakeCj();
    const auth = { authorization: `Bearer ${ADMIN}` };
    const r = await handleApi(new Request(`${BASE}/api/v1/admin/jobs/cj-sync`, { method: "POST", headers: auth }));
    expect(r.status).toBe(200);
    expect((await r.json()).listed).toBe(1);
    const st = await (await handleApi(new Request(`${BASE}/api/v1/admin/jobs`, { headers: auth }))).json();
    expect(st.last["cj-sync"].ok).toBe(true);
  });

  it("admin screen session: token only in body, httpOnly strict cookie, cross-origin refused", async () => {
    const bad = await handleApi(new Request(`${BASE}/api/v1/admin/session`, { method: "POST", body: JSON.stringify({ token: "wrong-wrong-wrong-wrong-wrong" }) }));
    expect(bad.status).toBe(401);
    const ok = await handleApi(new Request(`${BASE}/api/v1/admin/session`, { method: "POST", headers: { origin: BASE }, body: JSON.stringify({ token: ADMIN }) }));
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const pair = cookie.split(";")[0];
    const list = await handleApi(new Request(`${BASE}/api/v1/admin/supplier-orders`, { headers: { cookie: pair } }));
    expect(list.status).toBe(200);
    const evil = await handleApi(new Request(`${BASE}/api/v1/admin/supplier-orders/so_x/approve`, { method: "POST", headers: { cookie: pair, origin: "https://evil.example" }, body: "{}" }));
    expect(evil.status).toBe(403);
    const noOrigin = await handleApi(new Request(`${BASE}/api/v1/admin/supplier-orders/so_x/approve`, { method: "POST", headers: { cookie: pair }, body: "{}" }));
    expect(noOrigin.status).toBe(403);
    const sameOrigin = await handleApi(new Request(`${BASE}/api/v1/admin/supplier-orders/so_x/approve`, { method: "POST", headers: { cookie: pair, origin: BASE }, body: "{}" }));
    expect(sameOrigin.status).toBe(404);
  });
});
