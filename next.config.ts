import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@simplewebauthn/server", "stripe"],
  async rewrites() {
    return [
      { source: "/.well-known/mercavine-webhook-keys.json", destination: "/api/well-known/webhook-keys" },
      { source: "/.well-known/ucp", destination: "/api/well-known/ucp" },
    ];
  },
  async headers() {
    return [
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
