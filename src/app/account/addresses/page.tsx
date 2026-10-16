import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { listAddresses } from "@/lib/accounts";
import { userFromSessionToken } from "@/lib/auth";
import { AddressManager } from "./address-manager";

export const dynamic = "force-dynamic";

export default async function AddressesPage() {
  const jar = await cookies();
  const user = userFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect("/login?next=/account/addresses");
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-3xl px-5 py-8">
        <p className="text-sm"><Link href="/account" className="underline">← Account</Link></p>
        <h1 className="mt-2 text-4xl">Shipping addresses</h1>
        <div className="mt-6"><AddressManager addresses={listAddresses(user.id)} /></div>
      </section>
    </main>
  );
}
