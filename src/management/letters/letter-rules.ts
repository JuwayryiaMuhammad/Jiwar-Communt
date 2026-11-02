import { createHash } from 'node:crypto';

// ============================================================================
// Official letters (ADR 0080): the closed list of kinds, their numbers, and
// the code anyone checks a letter by.
// ============================================================================

export const LETTER_KINDS = [
  'residence_confirmation',
  'no_objection',
  'to_whom_it_may_concern',
] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];

/** The CHECK official_letters_text. */
export const ADDRESSEE = { min: 1, max: 150 } as const;
export const LETTER_SUBJECT = { min: 1, max: 300 } as const;

/** `OL-000123`: how a letter is named. */
export const letterNumber = (n: number) => `OL-${String(n).padStart(6, '0')}`;

/** 16 random bytes as base64url: 22 characters, 128 bits, never guessed. */
export const LETTER_CODE = /^[A-Za-z0-9_-]{22}$/;

/** The global pointer's key: the code's SHA-256, hex. */
export const letterCodeHash = (code: string) =>
  createHash('sha256').update(code, 'utf8').digest('hex');

/** The one line a letter states, in each language, by kind. */
export function statement(
  kind: LetterKind,
  facts: {
    name: string;
    unitCode: string;
    capacity: 'owner' | 'tenant';
    since: string;
    subject: string | null;
  },
): { en: string; ar: string } {
  const en = facts.capacity === 'owner' ? 'owner' : 'tenant';
  const ar = facts.capacity === 'owner' ? 'مالك' : 'مستأجر';
  const holds = {
    en: `${facts.name} holds unit ${facts.unitCode} as its ${en} since ${facts.since}`,
    ar: `${facts.name} يشغل الوحدة ${facts.unitCode} بصفته ${ar} منذ ${facts.since}`,
  };
  const about = facts.subject
    ? { en: ` Regarding: ${facts.subject}.`, ar: ` بخصوص: ${facts.subject}.` }
    : { en: '', ar: '' };
  switch (kind) {
    case 'residence_confirmation':
      return {
        en: `The management confirms that ${holds.en}.${about.en}`,
        ar: `تشهد الإدارة بأن ${holds.ar}.${about.ar}`,
      };
    case 'no_objection':
      return {
        en: `The management has no objection on the part of ${facts.name}, ${en} of unit ${facts.unitCode}.${about.en}`,
        ar: `لا مانع لدى الإدارة من جهة ${facts.name}، ${ar} الوحدة ${facts.unitCode}.${about.ar}`,
      };
    case 'to_whom_it_may_concern':
      return {
        en: `To whom it may concern: the management states that ${holds.en}.${about.en}`,
        ar: `إلى من يهمه الأمر: تشهد الإدارة بأن ${holds.ar}.${about.ar}`,
      };
  }
}

/** The title each kind is printed under. */
export const TITLES: Record<LetterKind, { en: string; ar: string }> = {
  residence_confirmation: { en: 'Residence confirmation', ar: 'إفادة سكن' },
  no_objection: { en: 'No-objection letter', ar: 'خطاب عدم ممانعة' },
  to_whom_it_may_concern: {
    en: 'To whom it may concern',
    ar: 'إلى من يهمه الأمر',
  },
};
