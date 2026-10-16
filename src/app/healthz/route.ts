import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Uptime check: 200 when the app and its SQLite volume answer, 503 otherwise. No internal details. */
export function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

export function HEAD() {
  const res = GET();
  return new Response(null, { status: res.status, headers: { "cache-control": "no-store" } });
}
