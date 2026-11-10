/**
 * The neighbours screens' checks that used to answer in English (logic.ts):
 * here they answer with a code, and the screen says it in the page's language
 * from the neighbours-posts and neighbours-complaint catalogs. The rules
 * themselves stay in logic.ts. No React and no `@/` alias, so the tests run
 * it as is.
 */
import { threadState, WELCOME_MAX, WELCOME_TEXTS, type Thread, type WelcomeForm, type WelcomeText } from './logic.ts';

export type ThreadWhy = 'complainantClosed' | 'noNotice' | 'unitClosed';

/** Why a thread takes no message now (`threadState`), or null when it does. */
export function threadWhy(thread: Thread, status: string, hasNotice: boolean): ThreadWhy | null {
  if (threadState(thread, status, hasNotice).write) return null;
  if (thread === 'complainant') return 'complainantClosed';
  return hasNotice ? 'unitClosed' : 'noNotice';
}

export type PostProblem = 'required' | 'maxBody' | 'maxPlace' | 'dayFormat' | 'future';

/** What is wrong with a staff post, by field (`postProblems`, in codes). */
export function postProblemCodes(
  form: { body: string; place: string; occurredOn: string },
  today: string,
): Partial<Record<'body' | 'place' | 'occurredOn', PostProblem>> {
  const problems: Partial<Record<'body' | 'place' | 'occurredOn', PostProblem>> = {};
  if (form.body.trim() === '') problems.body = 'required';
  else if (form.body.trim().length > 500) problems.body = 'maxBody';
  if (form.place.trim().length > 120) problems.place = 'maxPlace';
  if (form.occurredOn !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.occurredOn)) problems.occurredOn = 'dayFormat';
    else if (form.occurredOn > today) problems.occurredOn = 'future';
  }
  return problems;
}

export type WelcomeProblem = 'max' | 'language';

const LANGUAGES: readonly (readonly WelcomeText[])[] = [
  WELCOME_TEXTS.filter((k) => k.endsWith('En')),
  WELCOME_TEXTS.filter((k) => k.endsWith('Ar')),
];

/** What is wrong with the six welcome texts, by field (`welcomeProblems`, in codes). */
export function welcomeProblemCodes(form: WelcomeForm): Partial<Record<WelcomeText, WelcomeProblem>> {
  const problems: Partial<Record<WelcomeText, WelcomeProblem>> = {};
  for (const fields of LANGUAGES) {
    const some = fields.some((k) => form[k].trim() !== '');
    for (const k of fields) {
      const text = form[k].trim();
      if (text.length > WELCOME_MAX[k]) problems[k] = 'max';
      else if (some && text === '') problems[k] = 'language';
    }
  }
  return problems;
}
