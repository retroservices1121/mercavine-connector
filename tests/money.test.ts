import { describe, expect, it } from "vitest";
import { config } from "../src/lib/config";
import { applicationFee, feePercentLabel, platformFeeCents } from "../src/lib/money";

describe("platform fee", () => {
  it("defaults to 3% and takes $3.00 from a $100.00 seller charge", () => {
    delete process.env.PLATFORM_FEE_BPS;
    expect(config().platformFeeBps).toBe(300);
    expect(feePercentLabel(300)).toBe("3%");
    expect(applicationFee(10_000, 300)).toBe(300);
    expect(applicationFee(0, 300)).toBe(0);
    expect(platformFeeCents("stripe", 10_000, 300)).toBe(300);
    expect(platformFeeCents("mock", 10_000, 300)).toBe(300);
    expect(platformFeeCents("shop_pay", 10_000, 300)).toBe(0);
    expect(platformFeeCents("shop_pay", 2580, 300)).toBe(0);
  });
});
