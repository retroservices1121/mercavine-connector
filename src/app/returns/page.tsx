import { SiteFooter } from "@/components/site-footer";

const SUPPORT_EMAIL = "support@mercavine.com";
import { SiteHeader } from "@/components/site-header";

export const metadata = { title: "Mercavine Store returns" };

export default function ReturnsPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <article className="mx-auto max-w-2xl space-y-4 px-5 py-10 leading-relaxed">
          <h1 className="text-4xl">Mercavine Store returns</h1>
          <p>
            This policy covers items sold by <strong>Mercavine Store</strong>, which Mercavine sells itself and ships from US warehouses.
            Items from other sellers follow that seller&apos;s return policy, shown on the product and in your order.
          </p>
          <h2 className="text-2xl">What we cover</h2>
          <p>If your item arrives <strong>damaged, defective, or not what you ordered</strong>, tell us within <strong>30 days of delivery</strong>. We&apos;ll send a replacement or refund your original payment method, whichever you prefer when a replacement is available.</p>
          <h2 className="text-2xl">How to request it</h2>
          <p>Email <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with your order number and a photo or short video showing the problem. Your bot can also start the request from your order. You usually won&apos;t need to send the item back. If we do need it, we&apos;ll give you a prepaid label.</p>
          <h2 className="text-2xl">What we don&apos;t cover</h2>
          <p>We don&apos;t accept change-of-mind returns on Mercavine Store items, or damage caused after delivery. Reports made more than 30 days after delivery aren&apos;t covered.</p>
          <h2 className="text-2xl">Refund timing</h2>
          <p>Approved refunds go back to your original payment method, usually within 5 to 10 business days of approval. Refunds can&apos;t be sent anywhere else.</p>
          <h2 className="text-2xl">Contact us first</h2>
          <p>Please contact us before disputing a charge with your bank. We can usually fix the problem faster.</p>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
