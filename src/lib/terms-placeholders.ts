/**
 * Every legal or business fact on /terms that has not been confirmed yet.
 * Rendered on the page as a highlighted "[[PLACEHOLDER: label]]". Remove an entry only after
 * replacing its usage on the page with reviewed text (tests enforce the match).
 */
export type TermsPlaceholder = { id: string; label: string; section: string; note: string };

// All placeholders resolved as of October 16, 2026. Add entries here (and <Ph id> on /terms) only for new unconfirmed facts.
export const TERMS_PLACEHOLDERS: readonly TermsPlaceholder[] = [
] as const;

export const TERMS_PLACEHOLDER_IDS = new Set(TERMS_PLACEHOLDERS.map((p) => p.id));

export function termsPlaceholder(id: string): TermsPlaceholder {
  const found = TERMS_PLACEHOLDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown terms placeholder: ${id}`);
  return found;
}
