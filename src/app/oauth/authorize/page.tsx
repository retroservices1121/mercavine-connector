import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { buyerFromSessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { checkAuthorizeRequest, createConsentRequest } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const SCOPE_TEXT: Record<string, string> = {
  shop: "Search products for you",
  checkout: "Build carts and send them to you for approval (it can't pay without you)",
  track: "See order status and tracking, and start returns",
};

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") params.set(k, v);
  const cfg = config();
  const check = checkAuthorizeRequest(params);
  if (!check.ok && !check.fatal) redirect(check.redirect);
  if (!check.ok) {
    return (
      <main>
        <SiteHeader />
        <section className="mx-auto max-w-md px-5 py-10">
          <h1 className="text-3xl">Can&apos;t connect this app</h1>
          <p className="mt-3 text-sm text-[var(--muted)]">{check.message}</p>
        </section>
      </main>
    );
  }
  const jar = await cookies();
  const user = buyerFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`);
  const requestId = createConsentRequest(user.id, check);
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-md px-5 py-10">
        <h1 className="text-3xl">Connect {check.client.client_name} to {cfg.brandName}?</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Signed in as {user.email}. {check.client.client_name} will be able to:</p>
        <ul className="mt-4 space-y-2 text-sm">
          {check.scopes.map((s) => (
            <li key={s} className="rounded-2xl border border-[var(--line)] bg-[var(--card)] px-4 py-3">{SCOPE_TEXT[s] ?? s}</li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-[var(--muted)]">
          Your spending limits still apply, and every purchase needs your approval. You can disconnect it any time in Connect your bot.
        </p>
        <form method="post" action="/oauth/authorize/decision" className="mt-6 flex gap-3">
          <input type="hidden" name="request_id" value={requestId} />
          <Button type="submit" name="decision" value="approve" variant="vine">Approve</Button>
          <Button type="submit" name="decision" value="deny" variant="outline">Deny</Button>
        </form>
        <p className="mt-4 text-xs text-[var(--muted)]">You&apos;ll be sent back to {new URL(check.redirectUri).host}.</p>
      </section>
    </main>
  );
}
