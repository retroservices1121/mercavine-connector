import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { userFromSessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { shopLinkPublic } from "@/lib/shop-pay";
import { ConfirmShopLink } from "./confirm";

export const dynamic = "force-dynamic";

export default async function ShopLinkPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const jar = await cookies();
  const user = userFromSessionToken(jar.get("mv_session")?.value);
  const params = await searchParams;
  if (!user) redirect(`/login?next=${encodeURIComponent(`/shop/link?code=${params.code ?? ""}`)}`);
  const cfg = config();
  if (!cfg.shopPayEnabled) {
    return (
      <main>
        <SiteHeader signedIn />
        <section className="mx-auto max-w-xl px-5 py-16">
          <h1 className="text-4xl">Shop Pay is off</h1>
          <p className="mt-3 text-sm text-[var(--muted)]">Set SHOP_PAY_ENABLED=true to link a Shop Pay account.</p>
        </section>
      </main>
    );
  }
  const status = shopLinkPublic(user.id);
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-xl px-5 py-16">
        <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Sign in with Shop</p>
        <h1 className="mt-2 text-4xl">Link Shop Pay to {cfg.brandName}</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">
          This confirms the shopper, not a purchase. Card details are not collected here.
          {status.mode === "mock" ? " No Shop credentials are configured, so this link stays in mock mode." : ""}
        </p>
        <p className="mt-4 text-sm">Code {params.code || status.user_code || "—"}</p>
        {status.linked ? <p className="mt-4 text-sm">Linked{status.email ? ` as ${status.email}` : ""}.</p> : <ConfirmShopLink />}
        <Link href="/account" className="mt-6 inline-block text-sm underline">Back to your account</Link>
      </section>
    </main>
  );
}
