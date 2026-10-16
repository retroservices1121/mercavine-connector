import { SiteFooter, SUPPORT_EMAIL } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { config } from "@/lib/config";
import { feePercentLabel } from "@/lib/money";

export const metadata = { title: "Developers" };

const tools = [
  ["search_products", "Search the catalog. The bot never sees a card."],
  ["create_cart", "Build a cart. Price and stock are held on the server."],
  ["request_checkout", "Returns one short-lived approval link for the human to open and pay."],
  ["get_order_status / list_orders", "Poll status, totals, carrier and tracking for the connected user's orders."],
];

export default function DevelopersPage() {
  const cfg = config();
  const fee = feePercentLabel(cfg.platformFeeBps);
  return (
    <>
      <SiteHeader />
      <main>
        <article className="mx-auto max-w-2xl space-y-4 px-5 py-10 text-sm leading-relaxed">
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">For developers and bot platforms</p>
          <h1 className="text-4xl">Connect a bot to {cfg.brandName}</h1>
          <p>
            {cfg.brandName} exposes an MCP server at <code>https://{cfg.brandDomain}/mcp</code>. A shopper creates a bot token from their account page
            (scopes and spending limits included) and the bot sends it as a bearer token. The bot only sees that user&apos;s carts and orders.
          </p>
          <h2 className="text-2xl">Tools</h2>
          <ul className="space-y-2">
            {tools.map(([name, copy]) => (
              <li key={name}><code>{name}</code> — {copy}</li>
            ))}
          </ul>
          <h2 className="text-2xl">Payments</h2>
          <p>
            Native sellers are charged with Stripe Connect direct charges on their connected account. {cfg.brandName} takes {fee} via{" "}
            <code>application_fee_amount</code> (<code>PLATFORM_FEE_BPS</code>, default 300) before payout. Shop Pay and Shopify Catalog orders are paid on the
            merchant&apos;s checkout and carry no platform fee. Amazon Multi-Channel Fulfillment can ship orders for connected FBA sellers.
          </p>
          <h2 className="text-2xl">Data the bot never receives</h2>
          <p>Card numbers, CVC, card brand, last four, street address, or Stripe ids. Approval links store only a hash of the token. Webhook payloads are thin and signed.</p>
          <p>Questions: <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
