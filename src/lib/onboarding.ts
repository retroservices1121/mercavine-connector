/** Where the address step should send a buyer next. Pure so it can be unit-tested. */
export const ONBOARDING_DONE_PATH = "/account";

export function addressStepNext(opts: { onboarding: boolean; hasDefault: boolean }): string | null {
  return opts.onboarding && opts.hasDefault ? ONBOARDING_DONE_PATH : null;
}

/** Seller-only account copy and links (fee terms, Amazon seller accounts) are hidden from buyers. */
export function showSellerAccountItems(isSeller: boolean): boolean {
  return isSeller;
}
