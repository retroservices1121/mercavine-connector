import { SiteHeader } from "@/components/site-header";
import { config } from "@/lib/config";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const cfg = config();
  return (
    <main>
      <SiteHeader />
      <section className="mx-auto max-w-md px-5 py-10">
        <h1 className="text-4xl">Sign in</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Sign in with your Mercavine account. Passkeys can be enrolled after sign-in.
          {cfg.brandName} does not share this session with your bot.
        </p>
        <div className="mt-6 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
          <LoginForm nextPath={params.next} />
        </div>
      </section>
    </main>
  );
}
