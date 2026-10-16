import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main>
      <SiteHeader />
      <section className="mx-auto max-w-md px-5 py-10">
        <h1 className="text-4xl">Choose a new password</h1>
        <div className="mt-6 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
          {token ? <ResetForm token={token} /> : <p className="text-sm">This link is missing its token. <Link href="/forgot-password" className="underline">Request a new one</Link>.</p>}
        </div>
      </section>
    </main>
  );
}
