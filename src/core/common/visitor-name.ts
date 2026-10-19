/**
 * A visitor's name as the gate log search matches it (ADR 0056): exactly,
 * never a part of it or a likeness. The database computes the same key as
 * `visitor_details.name_key` (20261104090900_visitor_name_key); a unit spec
 * keeps the two in step.
 *
 * - Latin capitals lowered, A to Z only (never by a locale);
 * - Arabic letters folded as a plate's are: أ إ آ to ا, ى to ي, ة to ه;
 * - the short vowels and shadda (U+064B to U+0652) and the tatweel (U+0640)
 *   removed;
 * - runs of spaces, tabs and line ends made one space, the ends trimmed.
 */
export const NAME_FOLD_FROM =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZأإآىة' +
  String.fromCharCode(
    0x064b,
    0x064c,
    0x064d,
    0x064e,
    0x064f,
    0x0650,
    0x0651,
    0x0652,
    0x0640,
  );
/** What each folded character becomes; those past its end are removed. */
export const NAME_FOLD_TO = 'abcdefghijklmnopqrstuvwxyzااايه';

const FOLD = new Map(
  [...NAME_FOLD_FROM].map((c, i) => [c, NAME_FOLD_TO[i] ?? '']),
);

/** The key of a full name, as `visitor_details.name_key`; null for nothing left. */
export function nameKey(fullName: string): string | null {
  const folded = [...fullName].map((c) => FOLD.get(c) ?? c).join('');
  const key = folded.replace(/[ \t\r\n]+/g, ' ').replace(/^ +| +$/g, '');
  return key || null;
}
