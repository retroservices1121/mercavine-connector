import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { listBots } from "@/lib/accounts";
import { buyerFromSessionToken } from "@/lib/auth";
import { isEmailVerified } from "@/lib/email-auth";
import { VerifyBanner } from "../verify-banner";
import { config } from "@/lib/config";
import { formatUsd } from "@/lib/money";
import { AccountActions } from "../account-actions";
import { ConnectBotForm } from "./connect-bot-form";

export const dynamic = "force-dynamic";

export default async function BotsPage() {
  const jar = await cookies();
  const user = buyerFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect("/login?next=/account/bots");
  const bots = listBots(user.id);
  const mcpUrl = `${config().publicBaseUrl.replace(/\/$/, "")}/mcp`;
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-3xl px-5 py-8">
        <p className="text-sm"><Link href="/account" className="underline">← Account</Link></p>
        <h1 className="mt-2 text-4xl">Connect your bot</h1>
        {isEmailVerified(user.id) ? null : <VerifyBanner email={user.email} />}
        <div className="mt-6 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
          <ConnectBotForm mcpUrl={mcpUrl} />
        </div>
        <h2 className="mt-10 text-2xl">Your bots</h2>
        {bots.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">No bots connected yet.</p> : null}
        {bots.map((bot) => (
          <article key={bot.id} className="mt-4 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
            <h3 className="text-xl">{bot.name}</h3>
            {bot.needs_key ? (
              <p role="status" className="mt-1 text-sm text-[var(--danger)]">Needs a signing key. This bot will stop working for direct API calls once signatures are enforced. Connect it again with a key, then revoke this one.</p>
            ) : bot.mcp_only ? (
              <p className="mt-1 text-sm text-[var(--muted)]">MCP connector only (no signing key).</p>
            ) : null}
            <p className="mt-1 text-sm text-[var(--muted)]">
              Scopes {bot.scopes.join(", ")}. Per order {formatUsd(bot.per_order_limit_cents)}. Monthly {formatUsd(bot.per_month_limit_cents)}.
            </p>
            <div className="mt-4"><AccountActions botId={bot.id} revoked={Boolean(bot.revoked_at)} /></div>
          </article>
        ))}
      </section>
    </main>
  );
}
