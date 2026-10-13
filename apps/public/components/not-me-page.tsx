'use client';

import { post } from '@/lib/client';
import { RULES } from '@/lib/flow';
import { useLocale } from './locale';
import { ErrorNote, InvalidLink, Loading, Shell } from './shell';
import { useFlow } from './use-flow';
import { useLinkToken } from './use-link-token';

/** /a/not-me (ADR 0036): say what a freeze does, and only then do it. */
export function NotMePage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('action');
  const { state, run } = useFlow(RULES.accountNotMe);

  if (link.state === 'reading') return <Loading />;
  if (link.state === 'missing' || state.step === 'dead') return <InvalidLink />;

  if (state.step === 'done') {
    return (
      <Shell title={t('notme.done.title')}>
        <p role="status">{t('notme.done.body')}</p>
      </Shell>
    );
  }

  return (
    <Shell title={t('notme.title')}>
      <p>{t('notme.intro')}</p>
      <ul className="list">
        <li>{t('notme.effect.freeze')}</li>
        <li>{t('notme.effect.sessions')}</li>
        <li>{t('notme.effect.reactivate')}</li>
      </ul>
      <ErrorNote code={state.error} />
      <button
        type="button"
        className="button button--danger"
        disabled={state.busy}
        onClick={() => void run(() => post('public/not-me', { token: link.token }, locale), 'done')}
      >
        {t('notme.confirm')}
      </button>
    </Shell>
  );
}
