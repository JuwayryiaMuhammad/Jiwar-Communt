/** What ranking an alternative reads of a partner. */
export interface AlternativeCandidate {
  id: string;
  openNow: boolean;
  /** The residents' average, once enough rated it; null before. */
  average: number | null;
  listedAt: Date;
}

/** How many alternatives a suspended partner's page offers. */
export const MAX_ALTERNATIVES = 3;

/**
 * The alternatives to a suspended partner (ADR 0060): active partners of
 * one of its categories, open now first, then the best rated (a partner
 * not rated enough counts as unrated, after the rated ones), then the
 * newest listed; at most three. Pure: the page and its unit spec say the
 * same.
 */
export function rankAlternatives<T extends AlternativeCandidate>(
  candidates: readonly T[],
  excludeId: string,
): T[] {
  return candidates
    .filter((c) => c.id !== excludeId)
    .sort(
      (a, b) =>
        Number(b.openNow) - Number(a.openNow) ||
        (b.average ?? -1) - (a.average ?? -1) ||
        b.listedAt.getTime() - a.listedAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_ALTERNATIVES);
}
