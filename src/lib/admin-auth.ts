/**
 * Admin auth for the Mercavine Store. MERCAVINE_ADMIN_TOKEN (24+ chars) is accepted as a Bearer header
 * (cron/CLI) or as the httpOnly `mv_admin` cookie set by POST /api/v1/admin/session (the /admin/store
 * screen). Comparison is constant-time over SHA-256 digests. The token never goes in a URL or a log line.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "mv_admin";

export function adminTokenConfigured(): string | null {
  const t = process.env.MERCAVINE_ADMIN_TOKEN?.trim();
  return t && t.length >= 24 ? t : null;
}

export function adminTokenMatches(candidate: string | null | undefined): boolean {
  const expected = adminTokenConfigured();
  if (!expected || !candidate) return false;
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(candidate), h(expected));
}

export function readCookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export function adminCookie(value: string, maxAgeSec: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}
