import { describe, expect, it } from "vitest";
import { addressStepNext, showSellerAccountItems } from "@/lib/onboarding";

describe("buyer onboarding address step", () => {
  it("advances to the account page once a default address exists during onboarding", () => {
    expect(addressStepNext({ onboarding: true, hasDefault: true })).toBe("/account");
  });
  it("stays on the step when no default address exists yet", () => {
    expect(addressStepNext({ onboarding: true, hasDefault: false })).toBeNull();
  });
  it("does not redirect when managing addresses outside onboarding", () => {
    expect(addressStepNext({ onboarding: false, hasDefault: true })).toBeNull();
  });
});

describe("seller-only account items", () => {
  it("hides for buyers and shows for sellers", () => {
    expect(showSellerAccountItems(false)).toBe(false);
    expect(showSellerAccountItems(true)).toBe(true);
  });
});
