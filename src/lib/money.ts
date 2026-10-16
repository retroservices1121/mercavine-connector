export type Money = { amount: number; currency: "usd" };

export function money(amount: number, currency: "usd" = "usd"): Money {
  return { amount, currency };
}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/** Fee label for copy. 300 basis points renders as "3%". */
export function feePercentLabel(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? `${pct}%` : pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") + "%";
}

/** Platform fee for one seller charge. Default bps is PLATFORM_FEE_BPS (300 = 3%). */
export function applicationFee(amountCents: number, bps: number): number {
  const fee = Math.round((amountCents * bps) / 10_000);
  if (amountCents <= 0) return 0;
  return Math.min(fee, amountCents - 1);
}

/**
 * Shop Pay orders are paid on the merchant's own checkout. The 3% fee does not apply.
 * Stripe and mock direct charges use applicationFee.
 */
export function platformFeeCents(provider: "stripe" | "mock" | "shop_pay", amountCents: number, bps: number): number {
  if (provider === "shop_pay") return 0;
  return applicationFee(amountCents, bps);
}

export function taxCents(taxable: number, bps: number): number {
  return Math.round((taxable * bps) / 10_000);
}

/** Flat estimate by US region. This is not a tax engine. */
export function taxBpsForRegion(region: string | null | undefined, fallback: number): number {
  const code = (region ?? "").toUpperCase();
  const table: Record<string, number> = {
    FL: 750,
    GA: 800,
    TX: 825,
    CA: 975,
    NY: 880,
    WA: 1020,
  };
  return table[code] ?? fallback;
}
