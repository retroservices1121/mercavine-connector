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

  it("has 29 open placeholders and the confirmed facts are final text", () => {
    expect(TERMS_PLACEHOLDERS).toHaveLength(29);
    for (const gone of ["effective_date", "last_updated", "entity_name", "entity_type", "formation_state", "registered_address", "minimum_age", "eligible_regions", "account_deletion"]) {
      expect(TERMS_PLACEHOLDERS.some((p) => p.id === gone)).toBe(false);
    }
    expect(page).toContain("Mobi Media Inc., a Florida corporation");
    expect(page).toContain("October 16, 2026");
    expect(page).toContain("at least 18 years old");
    expect(page).toContain("available worldwide");
    expect(page).toContain("kept for up to 30 days after the request, then deleted");
    expect(TERMS_PLACEHOLDERS.some((p) => p.id === "legal_notice_address")).toBe(true);
  });
});
