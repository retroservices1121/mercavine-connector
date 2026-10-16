/** Pure display rules for the approval page, kept separate so they can be unit-tested. */
export type ApprovalViewInput = {
  digital_only?: boolean;
  lane?: string;
  tax_region?: { region: string | null; source: "shipping_address" | "billing_region" | "none" };
};

export function approvalDisplay(cart: ApprovalViewInput) {
  const digitalOnly = cart.digital_only === true;
  return {
    /** Ship-to block, address picker, and Shipping lines are hidden for all-digital carts. */
    showShipTo: !digitalOnly,
    showShipping: !digitalOnly,
    /** All-digital Mercavine carts with no known region must pick a billing state before paying. */
    needsBillingRegion: digitalOnly && (cart.lane ?? "native") === "native" && cart.tax_region?.source === "none",
    showBillingRegion: digitalOnly && (cart.lane ?? "native") === "native",
  };
}
