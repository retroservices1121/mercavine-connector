import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMS_PLACEHOLDERS } from "../src/lib/terms-placeholders";

const page = readFileSync(join(__dirname, "../src/app/terms/page.tsx"), "utf8");

describe("terms placeholders", () => {
  it("every placeholder in the list is used on /terms and every one used is listed", () => {
    const used = new Set([...page.matchAll(/<Ph id="([a-z0-9_]+)"/g)].map((m) => m[1]));
    const listed = TERMS_PLACEHOLDERS.map((p) => p.id);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...used].sort()).toEqual([...listed].sort());
  });

  it("each entry has a label and a section that exists on the page", () => {
    for (const p of TERMS_PLACEHOLDERS) {
      expect(p.label.length).toBeGreaterThan(2);
      if (p.section !== "header") expect(page).toContain(`["${p.section}",`);
    }
  });

  it("names no people and has no physical address", () => {
    expect(page).not.toMatch(/\bJoe\b|Perez|\bJP\b/);
    expect(page).toContain("accepts legal notices by email only");
  });

  it("has no open placeholders and reads as final", () => {
    expect(TERMS_PLACEHOLDERS).toHaveLength(0);
    expect(page).not.toMatch(/PLACEHOLDER|[Dd]raft|legal review|<Ph /);
    for (const s of ["Mobi Media Inc., a Florida corporation", "October 16, 2026", "at least 18 years old", "available worldwide",
      "kept for up to 30 days after the request, then deleted", "Mercavine is not the seller, buyer, or merchant of record",
      "the seller is the merchant of record", "3% of each completed sale", "Shop Pay carry no Mercavine fee",
      "Mercavine Copyright Agent", "American Arbitration Association", "Consumer Arbitration Rules", "seated in North Carolina",
      "small claims court in North Carolina", "Class action waiver", "laws of the State of North Carolina",
      "state or federal courts located in North Carolina", "mailto:support@mercavine.com"]) expect(page).toContain(s);
  });
});
