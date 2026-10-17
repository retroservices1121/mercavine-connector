import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { contentSecurityPolicy, securityHeaders } from "../src/lib/security-headers";

describe("security headers", () => {
  it("applies to every route and keeps the /a/ checkout headers", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const keys = all.headers.map((h) => h.key);
    for (const k of ["Strict-Transport-Security", "Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options", "Permissions-Policy"]) {
      expect(keys).toContain(k);
    }
    const a = rules.find((r) => r.source === "/a/:path*")!;
    expect(a.headers.find((h) => h.key === "Referrer-Policy")?.value).toBe("no-referrer");
    // /a/ rule comes after the global one so its Referrer-Policy wins
    expect(rules.indexOf(a)).toBeGreaterThan(rules.indexOf(all));
  });

  it("allows Stripe.js and the Payment Element", () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toMatch(/script-src [^;]*https:\/\/js\.stripe\.com/);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/js\.stripe\.com[^;]*https:\/\/hooks\.stripe\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/api\.stripe\.com/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("does not restrict form-action, so the OAuth consent redirect to the client works", () => {
    expect(contentSecurityPolicy(false)).not.toContain("form-action");
  });

  it("sends HSTS for two years", () => {
    const hsts = securityHeaders(false).find((h) => h.key === "Strict-Transport-Security")!;
    expect(hsts.value).toContain("max-age=63072000");
  });
});
