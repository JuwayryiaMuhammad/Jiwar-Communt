import ar from '@/messages/ar/units-review';
import en from '@/messages/en/units-review';

const codes = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([key, text]) => [key.slice('review.'.length), text]));

/** The words for a review reason, keyed by its code, for `useLabel(REVIEW_LABELS)`. */
export const REVIEW_LABELS = { en: codes(en), ar: codes(ar) };
