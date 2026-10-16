import { assertSameOrigin, readCookie, userFromSessionToken } from "@/lib/auth";
import { ApiError } from "@/lib/errors";
import { decideConsent } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
  } catch (e) {
    if (e instanceof ApiError) return new Response(e.message, { status: 403 });
    throw e;
  }
  const user = userFromSessionToken(readCookie(req, "mv_session"));
  if (!user) return new Response("Sign in again to continue.", { status: 401 });
  const form = await req.formData();
  const target = decideConsent(String(form.get("request_id") ?? ""), user.id, form.get("decision") === "approve");
  if (!target) return new Response("This sign-in request expired or was already used. Start again from the app.", { status: 400 });
  return new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
}
