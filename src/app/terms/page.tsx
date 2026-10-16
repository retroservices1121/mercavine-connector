import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata = { title: "Terms and Conditions" };

const sections: [string, string][] = [
  ["acceptance", "Acceptance of these terms"],
  ["who-we-are", "Who we are"],
  ["definitions", "Definitions"],
  ["accounts", "Accounts and eligibility"],
  ["shopper-terms", "Shopper terms"],
  ["bots", "AI agents and bots acting for you"],
  ["seller-terms", "Seller terms"],
  ["payments", "Payments"],
  ["orders", "Orders, pricing errors and cancellations"],
  ["shipping", "Shipping"],
  ["returns", "Returns and refunds"],
  ["conduct", "Policies, prohibited items and conduct"],
  ["ip", "Intellectual property and copyright agent"],
  ["third-party", "Third-party services"],
  ["fraud", "Suspension and appeals"],
  ["termination", "Termination"],
  ["disclaimers", "Disclaimers"],
  ["liability", "Limitation of liability"],
  ["indemnification", "Indemnification"],
  ["disputes", "Dispute resolution and arbitration"],
  ["governing-law", "Governing law and venue"],
  ["changes", "Changes to these terms"],
  ["notices", "Notices"],
  ["misc", "Miscellaneous"],
  ["contact", "Contact"],
];

function Section({ id, summary, children }: { id: string; summary: string; children: React.ReactNode }) {
  const index = sections.findIndex(([key]) => key === id);
  const title = sections[index][1];
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 md:p-8">
      <h2 id={`${id}-title`} className="text-2xl md:text-3xl">
        <span className="text-[var(--copper)]">{index + 1}.</span> {title}
      </h2>
      <p className="mt-3 rounded-2xl bg-[var(--paper)] px-4 py-3 text-sm">
        <span className="font-medium text-[var(--vine)]">In plain terms: </span>
        {summary}
      </p>
      <div className="mt-4 space-y-3 leading-relaxed text-[var(--ink)]/90">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="bg-[var(--vine)] text-[#f4efe4]">
          <div className="mx-auto max-w-6xl px-5 py-12 md:px-10">
            <p className="text-xs uppercase tracking-[0.18em] text-[#d7e7d4]">Legal</p>
            <h1 className="mt-2 text-5xl leading-[1.05] md:text-6xl">Terms and Conditions</h1>
            <p className="mt-4 max-w-2xl text-[#d7e7d4]">
              The rules for shopping and selling on Mercavine, including when an AI assistant shops for you.
            </p>
            <p className="mt-4 text-sm text-[#d7e7d4]">
              Effective: October 16, 2026 · Last updated: October 16, 2026
            </p>
          </div>
        </section>


        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-8 md:grid-cols-[240px_1fr] md:px-10">
          <nav aria-label="Table of contents" className="md:sticky md:top-6 md:max-h-[calc(100vh-3rem)] md:self-start md:overflow-y-auto">
            <details open className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5 md:open:block">
              <summary className="cursor-pointer font-medium">On this page</summary>
              <ol className="mt-3 space-y-1.5 text-sm text-[var(--muted)]">
                {sections.map(([id, title], i) => (
                  <li key={id}>
                    <a href={`#${id}`} className="hover:text-[var(--vine)] hover:underline">{i + 1}. {title}</a>
                  </li>
                ))}
              </ol>
            </details>
          </nav>

          <div className="space-y-6">
            <Section id="acceptance" summary="By using Mercavine, you agree to these terms. If you don't agree, please don't use it.">
              <p>These Terms and Conditions (the &ldquo;Terms&rdquo;) govern your use of the Mercavine website, accounts, seller tools, and the connections that let AI assistants shop on Mercavine (together, the &ldquo;Service&rdquo;). By creating an account, connecting a bot, listing products, or placing an order, you accept these Terms and our <a href="/privacy" className="underline">Privacy Policy</a>.</p>
              <p>If you use the Service for a business, you confirm you have authority to accept these Terms for that business.</p>
            </Section>

            <Section id="who-we-are" summary="Mercavine is a marketplace. Sellers sell their own products; Mercavine connects them with shoppers and their AI assistants.">
              <p>Mercavine is operated by Mobi Media Inc., a Florida corporation (&ldquo;Mercavine,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;). Mercavine is a brand of Mobi Media Inc.</p>
              <p>Mercavine is a marketplace. Each seller is the seller of record for the products they list. Unless we say otherwise for a specific product, Mercavine does not own, inspect, store, or ship the products sold on the Service.</p>
            </Section>

            <Section id="definitions" summary="A few words we use throughout, explained once.">
              <ul className="list-disc space-y-1 pl-5">
                <li><strong>Shopper</strong>: a person who buys, or approves purchases, on Mercavine.</li>
                <li><strong>Seller</strong>: a business or person that lists products for sale on Mercavine.</li>
                <li><strong>Bot</strong> or <strong>AI agent</strong>: software, such as Grok, that you connect to your account to search, build carts, and request checkout for you.</li>
                <li><strong>Order</strong>: a purchase you approve at checkout.</li>
                <li><strong>Platform fee</strong>: the fee Mercavine charges sellers on completed sales.</li>
              </ul>
            </Section>

            <Section id="accounts" summary="You need an account to buy or sell. Keep it accurate and secure, and you must meet the minimum age.">
              <p>You must be at least 18 years old to create an account. The Service is available worldwide, subject to local laws and to the destinations each seller ships to.</p>
              <p>You agree to give accurate information, keep your password private, and tell us promptly if you think your account has been used without permission. You are responsible for activity on your account.</p>
              <p>You can stop using the Service at any time. To delete your account, email <a href="mailto:privacy@mercavine.com" className="underline">privacy@mercavine.com</a>. Your account data is kept for up to 30 days after the request, then deleted, except where the law requires us to keep it longer.</p>
            </Section>

            <Section id="shopper-terms" summary="You decide what to buy. Nothing is charged until you approve it at checkout.">
              <p>Product information, prices, and stock come from sellers. Before you approve an order, review the items, price, shipping, and taxes shown at checkout. By approving, you make an offer to buy from the seller on those terms.</p>
              <p>You agree to use what you buy lawfully and not to resell it in violation of a seller&apos;s stated restrictions.</p>
            </Section>

            <Section id="bots" summary="If you connect an AI assistant, it acts for you, within the permissions and limits you set. You approve purchases and can disconnect it anytime.">
              <p>You may connect a bot to your account from your account page. When you do, you choose what it may do (for example, search, build carts, or check order status) and set spending limits.</p>
              <ul className="list-disc space-y-1 pl-5">
                <li><strong>You are responsible for your bot.</strong> Actions a connected bot takes within the permissions you granted are treated as your actions.</li>
                <li><strong>You approve purchases.</strong> A bot can prepare a cart, but an order is placed only when you approve it at checkout, or under an automatic-approval rule you set yourself.</li>
                <li><strong>Spending limits.</strong> Limits you set (per order and per month) are enforced by the Service. They are a safeguard, not a guarantee against every mistake your bot makes.</li>
                <li><strong>Revoking access.</strong> You can disconnect a bot at any time from your account page. This stops its access and cancels its open carts. Keep your bot&apos;s access credentials secret; treat them like a password.</li>
                <li>Bots never receive your card details.</li>
              </ul>
            </Section>

            <Section id="seller-terms" summary="Sellers run their own business on Mercavine. You are the seller of record and are responsible for your products, shipping, returns, refunds and taxes. Mercavine takes 3% on Stripe sales and nothing on Shop Pay orders.">
              <p><strong>Mercavine is a venue.</strong> Mercavine provides the place and tools that let shoppers and their AI assistants find and buy from independent sellers. Mercavine is not the seller, buyer, or merchant of record for any sale, and is not a party to the contract of sale between a shopper and a seller.</p>
              <p><strong>Eligibility.</strong> To sell, you must be at least 18, be able to form a binding contract, provide accurate business and identity information, and complete and keep in good standing the verification that Stripe requires for your connected account. We may decline or remove a seller account in line with the Suspension and appeals section.</p>
              <p><strong>Listings.</strong> You are solely responsible for your listings, including titles, descriptions, images, prices, stock, shipping terms, return policy, and any required legal disclosures or warnings. Listings must be accurate, lawful and kept up to date, and you must have every right needed to sell what you list. Listings must follow the Policies section below.</p>
              <p><strong>Your responsibilities.</strong> You alone are responsible for fulfilling orders; shipping and delivery; returns, refunds, exchanges and cancellations; product quality, safety, authenticity and warranties; customer service for your sales; and compliance with all laws that apply to your products and business.</p>
              <p><strong>Fees.</strong> For orders paid through Mercavine&apos;s Stripe checkout, Mercavine charges a platform fee of 3% of each completed sale, deducted before your payout and not added to the shopper&apos;s total. Stripe&apos;s processing fees are separate and are charged under your Stripe agreement. Orders paid with Shop Pay carry no Mercavine fee. We will give you at least 30 days&apos; notice before increasing our fee.</p>
              <p><strong>Stripe.</strong> Payments are processed by Stripe through a Stripe connected account in your name. By selling on Mercavine you agree to the <a href="https://stripe.com/connect-account/legal" className="underline">Stripe Connected Account Agreement</a>, which includes the Stripe Services Agreement.</p>
              <p><strong>Payouts.</strong> Sale proceeds, less Mercavine&apos;s fee, are paid out to your bank account by Stripe on your Stripe payout schedule. Stripe or Mercavine may delay or hold payouts where Stripe&apos;s terms allow, or under the Suspension and appeals section.</p>
              <p><strong>Taxes.</strong> You are responsible for determining, collecting, reporting and paying all taxes on your sales, including sales, use and value-added taxes, except where a law specifically requires Mercavine to collect or remit a tax as a marketplace facilitator, in which case we will tell you.</p>
              <p><strong>Fulfillment.</strong> You must ship within the handling time stated on your listing, or within 3 business days if none is stated, and provide tracking where available. If you can&apos;t fulfill an order, cancel it promptly so the shopper is refunded. If you connect Amazon Multi-Channel Fulfillment, eligible orders may ship from your Amazon inventory, and your agreements with Amazon also apply.</p>
            </Section>

            <Section id="payments" summary="You pay the seller. Mercavine collects payment on the seller's behalf through Stripe, or the seller's Shopify store handles it with Shop Pay. Mercavine doesn't store your card.">
              <p><strong>How payment works.</strong> When you pay through Mercavine&apos;s checkout, the charge is made by Stripe on behalf of the seller, and the seller is the merchant of record. Mercavine acts only as a limited agent of the seller for collecting payment; once your payment succeeds, you have paid the seller. For some Shopify stores you may pay with Shop Pay, in which case the store&apos;s own checkout and terms apply.</p>
              <p><strong>Card details.</strong> Mercavine does not store your full card details, and connected bots never receive them.</p>
              <p><strong>Failed and reversed payments.</strong> If a payment fails or is reversed, the order may be cancelled.</p>
              <p><strong>Chargebacks.</strong> Because the seller is merchant of record, chargebacks and payment disputes are the seller&apos;s responsibility. Sellers must respond to them through Stripe and bear any resulting losses and dispute fees. Mercavine may share order information with the seller and Stripe to help resolve a dispute.</p>
            </Section>

            <Section id="orders" summary="Your order is a purchase from the seller. Sellers handle cancellations and may cancel orders with obvious pricing errors.">
              <p><strong>Placing an order.</strong> When you approve checkout, you make an offer to buy from the seller on the terms shown. The contract is between you and the seller; it is formed when the seller accepts or ships the order.</p>
              <p><strong>Prices and stock.</strong> Prices and stock come from sellers and are held for a limited time once a cart is ready for checkout; after that, they may change.</p>
              <p><strong>Pricing errors.</strong> If a listing has an obvious error in price or description, the seller may cancel the order before it ships, and any amount charged will be refunded.</p>
              <p><strong>Cancellations.</strong> To cancel an order, contact the seller. Whether an order can be cancelled after you approve it is up to the seller&apos;s policy and whether it has shipped. A seller may cancel an order it can&apos;t fulfill, and you will be refunded for any amount charged.</p>
            </Section>

            <Section id="shipping" summary="Sellers ship your order and are responsible for it until it's delivered. Contact the seller about delivery problems.">
              <p>Each seller decides where it ships and sets its own shipping costs, methods and handling times, which are shown on the listing or at checkout. Delivery dates are estimates, not guarantees.</p>
              <p>Mercavine does not ship products. Questions about delivery, delays, or lost or damaged packages go to the seller, who is responsible for the order until it is delivered and for any claim with its carrier.</p>
            </Section>

            <Section id="returns" summary="Returns and refunds are handled by the seller under the seller's own return policy. Contact the seller directly.">
              <p>Each seller sets its own return and refund policy, shown on its listings, and must follow any return or refund rights the law gives you. That policy decides the return window and who pays return shipping.</p>
              <p>To request a return or refund, contact the seller directly. Mercavine does not accept returns, issue refunds for sellers, or decide return requests, though we may pass your message along or help you reach the seller.</p>
              <p>Refunds approved by the seller go back to the original payment method. Mercavine&apos;s platform fee on a refunded order may be retained unless we choose to return it.</p>
            </Section>

            <Section id="conduct" summary="Follow our policies: no prohibited items, no fraud, and no misuse of Mercavine or its systems.">
              <p>You must follow these Terms and any policies we publish on the Service, which form part of these Terms.</p>
              <p><strong>Prohibited items.</strong> Sellers may not list or sell:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Anything illegal where it is sold or shipped, or stolen goods.</li>
                <li>Firearms, ammunition, firearm parts, explosives and other weapons.</li>
                <li>Illegal, prescription or controlled drugs, drug paraphernalia, and cannabis or THC products.</li>
                <li>Tobacco, vaping products and alcohol.</li>
                <li>Hazardous materials, recalled products, and products that fail applicable safety rules.</li>
                <li>Counterfeit or infringing goods, and items that violate anyone&apos;s intellectual property or privacy.</li>
                <li>Adult sexual content, and content that promotes hate, violence or the exploitation of others.</li>
                <li>Live animals, human remains or body parts, and endangered species products.</li>
                <li>Gift cards, currency, securities, and digital services that Stripe doesn&apos;t allow, and anything else prohibited by Stripe&apos;s restricted businesses list.</li>
              </ul>
              <p><strong>Prohibited conduct.</strong></p>
              <ul className="list-disc space-y-1 pl-5">
                <li>No fraud, fake orders, fake reviews, or misleading listings.</li>
                <li>No accessing accounts, bots, or data that aren&apos;t yours.</li>
                <li>No scraping, overloading, probing, or interfering with the Service, except through the connections we provide and within their limits.</li>
                <li>No using the Service to break the law or anyone else&apos;s rights.</li>
              </ul>
            </Section>

            <Section id="ip" summary="Mercavine's brand and software are ours. Sellers keep their content but let us show it. Report infringement to our copyright agent.">
              <p>The Mercavine name, logo, and Service are owned by Mercavine. You may not use them without permission, except to describe the Service accurately.</p>
              <p>Sellers keep ownership of their listing content and grant Mercavine a non-exclusive, worldwide, royalty-free license to host, display, adapt for display, and share it with shoppers and their connected bots to operate and promote the Service.</p>
              <p><strong>Copyright and infringement notices.</strong> If you believe content on the Service infringes your copyright or other rights, send a notice to: Mercavine Copyright Agent, <a href="mailto:privacy@mercavine.com" className="underline">privacy@mercavine.com</a>. Include your contact details, a description of the work and of the material you say infringes it (with its location on the Service), a statement that you believe in good faith the use is not authorized, a statement that the notice is accurate and, under penalty of perjury, that you are the owner or authorized to act for the owner, and your physical or electronic signature. A seller whose content is removed may send a counter-notice to the same address. We remove infringing content and terminate repeat infringers in appropriate circumstances.</p>
            </Section>

            <Section id="third-party" summary="Some parts of Mercavine rely on other companies, and their terms apply too.">
              <p>The Service works with third parties such as Stripe, Shopify and Shop Pay, Amazon, email providers, and AI assistants such as Grok. Their services are governed by their own terms and privacy policies, and Mercavine is not responsible for them.</p>
            </Section>

            <Section id="fraud" summary="We may limit or suspend accounts, bots, listings or orders to protect the marketplace. We'll tell you why, and you can appeal.">
              <p><strong>What we may do.</strong> We may review, hold or cancel orders; remove listings; limit, suspend or close accounts or bots; or hold payouts where Stripe&apos;s terms allow, if we reasonably believe there is fraud, abuse, risk to shoppers or to Mercavine, a breach of these Terms or our policies, or a legal requirement.</p>
              <p><strong>Notice.</strong> Unless the law, an investigation, or a safety risk prevents it, we will tell you by email what action we took and why.</p>
              <p><strong>Appeals.</strong> You may appeal within 30 days by emailing <a href="mailto:support@mercavine.com" className="underline">support@mercavine.com</a> with your account email and any information that supports your appeal, such as a plan to fix the issue. We aim to respond within 14 days. Our decision on appeal is final, without limiting your rights under the Dispute resolution section.</p>
            </Section>

            <Section id="termination" summary="You can leave anytime. We can end access for breaches, or with notice otherwise.">
              <p>You may stop using the Service and close your account at any time. We may suspend or end your access immediately for serious breaches of these Terms, or otherwise with at least 30 days&apos; notice. Sellers must still fulfill, or cancel and refund, open orders after termination.</p>
              <p>Sections that by their nature should survive (such as fees owed, disclaimers, limitation of liability, indemnification, and dispute resolution) survive termination.</p>
            </Section>

            <Section id="disclaimers" summary="We work hard to keep Mercavine running well, but we can't promise it will be perfect.">
              <p>To the fullest extent the law allows, the Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of any kind. Products are sold by sellers, and Mercavine makes no promise about any product, listing, seller or shopper. Any product warranty comes from the seller or manufacturer. Results produced by AI assistants may be inaccurate; review your cart before you approve.</p>
            </Section>

            <Section id="liability" summary="If something goes wrong, there are limits on what Mercavine can be held liable for.">
              <p>To the fullest extent the law allows, Mercavine is not liable for indirect, incidental, special, consequential, or punitive damages, or for the products, acts or omissions of sellers, shoppers or third parties. Our total liability for any claim is limited to the greater of the fees you paid Mercavine in the 12 months before the claim or US$100. Some places don&apos;t allow these limits, so they may not apply to you.</p>
            </Section>

            <Section id="indemnification" summary="If your actions cause a legal claim against Mercavine, you agree to cover it.">
              <p>You agree to defend and indemnify Mercavine against claims, losses, and costs arising from your breach of these Terms, your misuse of the Service, your bot&apos;s actions within the permissions you granted, or, for sellers, your products, listings, fulfillment, refunds and taxes.</p>
            </Section>

            <Section id="disputes" summary="Disputes with a seller about an order go to the seller. For disputes with Mercavine, contact us first; if we can't resolve it, it goes to individual binding arbitration in North Carolina, with small claims allowed.">
              <p><strong>Disputes with sellers.</strong> Disputes about a product or order are between you and the seller. Mercavine may, but does not have to, help you reach a resolution.</p>
              <p><strong>Informal resolution.</strong> Before filing a claim against Mercavine, email <a href="mailto:privacy@mercavine.com" className="underline">privacy@mercavine.com</a> describing the dispute and what you want. We will both try in good faith to resolve it within 60 days.</p>
              <p><strong>Binding arbitration.</strong> Any dispute or claim between you and Mercavine relating to the Service or these Terms that isn&apos;t resolved informally will be resolved by binding individual arbitration administered by the American Arbitration Association (AAA) under its Consumer Arbitration Rules (or its Commercial Arbitration Rules for disputes with sellers acting as a business). The arbitration will be seated in North Carolina, and may be held by video or phone. The Federal Arbitration Act governs this section. Judgment on the award may be entered in any court with jurisdiction.</p>
              <p><strong>Small claims.</strong> Either party may instead bring an individual claim in small claims court in North Carolina if it qualifies.</p>
              <p><strong>Class action waiver.</strong> Claims may be brought only individually, not as a plaintiff or class member in any class, collective, consolidated or representative proceeding, and the arbitrator may not combine claims of more than one person. If this waiver is found unenforceable for a claim, that claim will be heard in court under the Governing law and venue section, not in arbitration.</p>
              <p><strong>Opting out.</strong> You may opt out of arbitration by emailing <a href="mailto:privacy@mercavine.com" className="underline">privacy@mercavine.com</a> within 30 days after you first accept these Terms, including your name, account email and a clear statement that you opt out.</p>
            </Section>

            <Section id="governing-law" summary="North Carolina law applies, and court cases are heard in North Carolina.">
              <p>These Terms are governed by the laws of the State of North Carolina and applicable US federal law, without regard to conflict-of-law rules. Any claim not subject to arbitration will be heard only in the state or federal courts located in North Carolina, and you and Mercavine consent to their personal jurisdiction.</p>
            </Section>

            <Section id="changes" summary="If we change these terms, we'll tell you before the changes apply.">
              <p>We may update these Terms. For material changes we will give notice at least 30 days before they take effect, by email or on the Service. Continuing to use the Service after that means you accept the updated Terms.</p>
            </Section>

            <Section id="notices" summary="How we send you notices and how you send legal notices to us.">
              <p>We may send notices to the email on your account or post them on the Service. Legal notices to Mercavine must be sent by email to <a href="mailto:privacy@mercavine.com" className="underline">privacy@mercavine.com</a>. Mercavine accepts legal notices by email only.</p>
            </Section>

            <Section id="misc" summary="The standard fine print that keeps the rest working.">
              <p>These Terms, with the Privacy Policy and any policies referenced here, are the entire agreement between you and Mercavine about the Service. If any part is unenforceable, the rest still applies. Our not enforcing a right is not a waiver. You may not transfer these Terms without our consent; we may transfer them in a merger, acquisition, or sale of assets. Neither party is liable for delays caused by events beyond reasonable control.</p>
            </Section>

            <Section id="contact" summary="Questions? Get in touch.">
              <p>Mercavine</p>
              <p>Support: <a href="mailto:support@mercavine.com" className="underline">support@mercavine.com</a></p>
              <p>Privacy and legal notices: <a href="mailto:privacy@mercavine.com" className="underline">privacy@mercavine.com</a></p>
            </Section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
