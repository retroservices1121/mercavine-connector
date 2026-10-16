import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountDeletion, ACCOUNT_DATA_RETENTION_DAYS, PRIVACY_EMAIL } from "@/lib/privacy-content";

describe("privacy account deletion", () => {
  it("matches the terms", () => {
    expect(PRIVACY_EMAIL).toBe("privacy@mercavine.com");
    expect(ACCOUNT_DATA_RETENTION_DAYS).toBe(30);
    expect(accountDeletion.retention).toContain("30 days");
    expect(accountDeletion.retention).toContain("law requires");
    expect(accountDeletion.orders).toContain("tax and dispute");
    expect(accountDeletion.bots).toContain("account page");
  });
  it("is rendered on the privacy page", () => {
    const page = readFileSync("src/app/privacy/page.tsx", "utf8");
    for (const key of ["heading", "retention", "orders", "bots"]) expect(page).toContain(`accountDeletion.${key}`);
    expect(page).toContain("mailto:${PRIVACY_EMAIL}");
  });
});
