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

  it("names no people and does not assume privacy@ for legal notices", () => {
    expect(page).not.toMatch(/\bJoe\b|Perez|\bJP\b/);
    expect(page).not.toMatch(/legal_notice_email[^\n]*privacy@/);
  });
});
