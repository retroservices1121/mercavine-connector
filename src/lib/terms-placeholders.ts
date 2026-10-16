/**
 * Every legal or business fact on /terms that has not been confirmed yet.
 * Rendered on the page as a highlighted "[[PLACEHOLDER: label]]". Remove an entry only after
 * replacing its usage on the page with reviewed text (tests enforce the match).
 */
export type TermsPlaceholder = { id: string; label: string; section: string; note: string };

export const TERMS_PLACEHOLDERS: readonly TermsPlaceholder[] = [
  { id: "effective_date", label: "Effective date", section: "header", note: "Date these terms take effect." },
  { id: "last_updated", label: "Last-updated date", section: "header", note: "Update on every revision." },
  { id: "entity_name", label: "Legal entity name", section: "who-we-are", note: "Exact registered name of the company operating Mercavine." },
  { id: "entity_type", label: "Entity type (e.g. LLC, corporation)", section: "who-we-are", note: "Confirm with formation documents." },
  { id: "formation_state", label: "State of formation", section: "who-we-are", note: "State where the entity is registered." },
  { id: "registered_address", label: "Registered business address", section: "who-we-are", note: "Used for legal notices; may differ from a mailing address." },
  { id: "minimum_age", label: "Minimum age to use Mercavine", section: "accounts", note: "e.g. 18 or age of majority; confirm with counsel." },
  { id: "eligible_regions", label: "Countries or states where Mercavine is available", section: "accounts", note: "Current product assumes US shipping addresses; confirm legal scope." },
  { id: "account_deletion", label: "Account deletion process and data retention reference", section: "accounts", note: "Link to the privacy policy section and describe how to request deletion." },
  { id: "prohibited_items", label: "Confirmed prohibited and restricted items list", section: "seller-terms", note: "Draft list on page is based on current launch scope; needs legal and payments review." },
  { id: "seller_eligibility", label: "Seller eligibility requirements (business type, location, verification)", section: "seller-terms", note: "Beyond Stripe's own verification." },
  { id: "payout_timing", label: "Seller payout timing", section: "seller-terms", note: "Depends on Stripe payout schedule and any reserve; confirm." },
  { id: "fee_change_notice", label: "Notice period before fee changes", section: "seller-terms", note: "e.g. number of days; confirm." },
  { id: "tax_responsibility", label: "Sales tax collection and remittance responsibility", section: "seller-terms", note: "Marketplace facilitator rules vary by state; needs tax advice." },
  { id: "seller_fulfillment_sla", label: "Seller shipping and handling time requirements", section: "seller-terms", note: "Maximum handling time before an order may be cancelled." },
  { id: "chargeback_handling", label: "Chargeback and dispute handling between sellers and Mercavine", section: "payments", note: "Who responds, who bears losses and fees." },
  { id: "pricing_error_policy", label: "Pricing error policy", section: "orders", note: "Whether and when an order with an obvious pricing error may be cancelled." },
  { id: "cancellation_window", label: "Order cancellation window", section: "orders", note: "How long after approval a shopper can cancel." },
  { id: "shipping_regions", label: "Shipping destinations and restrictions", section: "shipping", note: "Confirm supported destinations." },
  { id: "lost_package_policy", label: "Lost or damaged package responsibility", section: "shipping", note: "Seller vs carrier vs Mercavine." },
  { id: "refund_window", label: "Default return and refund window", section: "returns", note: "Number of days; sellers may set their own within limits." },
  { id: "return_shipping_payer", label: "Who pays return shipping", section: "returns", note: "By reason (defect vs change of mind)." },
  { id: "marketplace_refund_policy", label: "Marketplace refund responsibility (seller vs Mercavine)", section: "returns", note: "Whether Mercavine ever refunds on a seller's behalf, and the 3% fee on refunds." },
  { id: "dmca_agent", label: "Copyright / IP agent name and contact", section: "ip", note: "Register a DMCA agent with the US Copyright Office if relying on safe harbor." },
  { id: "suspension_process", label: "Suspension and appeal process", section: "fraud", note: "How users are notified and can appeal." },
  { id: "termination_notice", label: "Notice period for termination without cause", section: "termination", note: "Both by Mercavine and by sellers." },
  { id: "liability_cap", label: "Liability cap amount or formula", section: "liability", note: "e.g. greater of fees paid in the last N months or a fixed amount." },
  { id: "dispute_method", label: "Dispute method (arbitration or court)", section: "disputes", note: "Decide between binding arbitration and courts." },
  { id: "arbitration_provider", label: "Arbitration provider and rules", section: "disputes", note: "Only if arbitration is chosen." },
  { id: "class_action_waiver", label: "Class-action waiver (yes/no)", section: "disputes", note: "Enforceability varies; counsel to confirm." },
  { id: "small_claims_carveout", label: "Small-claims court carve-out (yes/no)", section: "disputes", note: "" },
  { id: "arbitration_opt_out", label: "Arbitration opt-out window and method", section: "disputes", note: "e.g. number of days after accepting, and how to send the opt-out." },
  { id: "governing_law_state", label: "Governing law state", section: "governing-law", note: "" },
  { id: "venue", label: "Venue: court and county", section: "governing-law", note: "Where non-arbitrable claims are heard." },
  { id: "terms_change_notice", label: "Notice period before changes to these terms take effect", section: "changes", note: "" },
  { id: "legal_notice_email", label: "Email for legal notices", section: "notices", note: "Do not assume privacy@mercavine.com." },
  { id: "legal_notice_address", label: "Mailing address for legal notices", section: "notices", note: "May be the registered address." },
  { id: "support_email", label: "Customer support email", section: "contact", note: "Confirm the support address to publish." },
] as const;

export const TERMS_PLACEHOLDER_IDS = new Set(TERMS_PLACEHOLDERS.map((p) => p.id));

export function termsPlaceholder(id: string): TermsPlaceholder {
  const found = TERMS_PLACEHOLDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown terms placeholder: ${id}`);
  return found;
}
