import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { listAddresses } from "@/lib/accounts";
import { buyerFromSessionToken } from "@/lib/auth";
import { isEmailVerified } from "@/lib/email-auth";
import { VerifyBanner } from "../verify-banner";
import { AddressManager } from "./address-manager";
import { addressStepNext } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

export default async function AddressesPage({ searchParams }: { searchParams: Promise<{ onboarding?: string }> }) {
  const onboarding = (await searchParams).onboarding === "1";
  const jar = await cookies();
  const user = buyerFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect("/login?next=/account/addresses");
  const addresses = listAddresses(user.id);
  // Onboarding: a buyer who already has a default address skips this step.
  const next = addressStepNext({ onboarding, hasDefault: addresses.some((a) => a.is_default) });
  if (next) redirect(next);
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-3xl px-5 py-8">
        <p><Link href="/account" className={buttonVariants({ variant: "outline", className: "h-9 px-4" })}>Back</Link></p>
        <h1 className="mt-2 text-4xl">Shipping addresses</h1>
        {isEmailVerified(user.id) ? null : <VerifyBanner email={user.email} />}
        <div className="mt-6"><AddressManager addresses={addresses} onboarding={onboarding} /></div>
      </section>
    </main>
  );
}
