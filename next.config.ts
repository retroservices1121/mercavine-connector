import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@simplewebauthn/server", "stripe"],
  async rewrites() {
    return [
      { source: "/.well-known/mercavine-webhook-keys.json", destination: "/api/well-known/webhook-keys" },
      { source: "/.well-known/ucp", destination: "/api/well-known/ucp" },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders() },
      {
        source: "/a/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
