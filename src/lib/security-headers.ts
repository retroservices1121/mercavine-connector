/**
 * Site-wide security headers (SP-API DPP: encryption in transit, hardening).
 *
 * CSP notes:
 * - Stripe.js and the Payment Element load from js.stripe.com and frame
 *   js.stripe.com / hooks.stripe.com (3-D Secure); see Stripe's CSP guide.
 * - Next.js App Router emits inline bootstrap scripts, so script-src keeps
 *   'unsafe-inline' (no nonce pipeline yet). 'unsafe-eval' is dev-only.
 * - form-action is intentionally NOT set: the OAuth consent form posts to
 *   /oauth/authorize/decision, which 302s to the client's redirect_uri
 *   (e.g. grok.com). Browsers apply form-action to that redirect, so a
 *   restrictive value would break connector sign-in.
 */
export function contentSecurityPolicy(dev = process.env.NODE_ENV !== "production"): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), "https://js.stripe.com", "https://*.js.stripe.com"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      "https://api.stripe.com",
      "https://*.stripe.com",
      "https://*.stripe.network",
      "https://maps.googleapis.com",
      ...(dev ? ["ws:", "wss:"] : []),
    ],
    "frame-src": ["'self'", "https://js.stripe.com", "https://*.js.stripe.com", "https://hooks.stripe.com"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "usb=()",
  "interest-cohort=()",
  'payment=(self "https://js.stripe.com")',
  "publickey-credentials-get=(self)",
  "publickey-credentials-create=(self)",
].join(", ");

export function securityHeaders(dev = process.env.NODE_ENV !== "production"): { key: string; value: string }[] {
  return [
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "Content-Security-Policy", value: contentSecurityPolicy(dev) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  ];
}
