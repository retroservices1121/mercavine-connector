import { describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/healthz/route";
import { __setSentryForTests, initMonitoring, scrubEvent, securityAlert, sentryEnabled } from "../src/lib/monitoring";
import { useTempDb } from "./db";

describe("monitoring", () => {
  useTempDb();

  it("is inert without SENTRY_DSN", async () => {
    delete process.env.SENTRY_DSN;
    expect(sentryEnabled()).toBe(false);
    await initMonitoring();
    expect(() => securityAlert("login_lockout")).not.toThrow();
  });

  it("forwards security alerts, including plain [security-alert] log lines, to Sentry", () => {
    const captureMessage = vi.fn();
    __setSentryForTests({ captureException: vi.fn(), captureMessage });
    const warn = vi.spyOn(console, "warn");
    securityAlert("approval_security_hold", { cart_id: "crt_1" });
    console.warn("[security-alert] login lockout kind=account until=2026-10-17T00:00:00Z");
    console.warn("unrelated warning");
    expect(captureMessage).toHaveBeenCalledTimes(2);
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ level: "warning", tags: { security_alert: "approval_security_hold" } });
    expect(captureMessage.mock.calls[1][1]).toMatchObject({ tags: { security_alert: "login" } });
    warn.mockRestore();
    __setSentryForTests(null);
  });

  it("scrubs auth headers, cookies and bodies", () => {
    const e = scrubEvent({ request: { headers: { Authorization: "Bearer x", Cookie: "mv_session=1", "user-agent": "ua" }, cookies: { a: 1 }, data: "pw" } });
    expect(e.request.headers!.Authorization).toBe("[redacted]");
    expect(e.request.headers!.Cookie).toBe("[redacted]");
    expect(e.request.headers!["user-agent"]).toBe("ua");
    expect(e.request.data).toBeUndefined();
  });

  it("serves /healthz", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
