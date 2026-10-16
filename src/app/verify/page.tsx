import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { verifyEmail } from "@/lib/email-auth";
import { ApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let ok = false;
  let message = "This link is invalid or has expired.";
  try {
    if (token) {
      verifyEmail(token);
      ok = true;
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    message = error.message;
  }
  return (
    <main>
      <SiteHeader />
      <section className="mx-auto max-w-md px-5 py-10">
        <h1 className="text-4xl">{ok ? "Email verified" : "Could not verify"}</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">
          {ok ? "Thanks. Your bot can now start checkouts for you." : `${message} Sign in and resend the verification email from your account.`}
        </p>
        <p className="mt-6 text-sm"><Link href="/account" className="underline">Go to your account</Link></p>
      </section>
    </main>
  );
}
