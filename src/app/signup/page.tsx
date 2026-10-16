import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { SignupForm } from "./signup-form";

export default function SignupPage() {
  return (
    <main>
      <SiteHeader />
      <section className="mx-auto max-w-md px-5 py-10">
        <h1 className="text-4xl">Create an account</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          You need an account to approve purchases, save shipping addresses, and connect a shopping bot.
        </p>
        <div className="mt-6 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
          <SignupForm />
        </div>
        <p className="mt-4 text-sm">
          Already have an account? <Link href="/login" className="underline">Sign in</Link>
        </p>
      </section>
    </main>
  );
}
