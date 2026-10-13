'use client';

import { useState } from 'react';
import { post } from '@/lib/client';
import { RULES } from '@/lib/flow';
import { isCode } from '@/lib/registration';
import { CodeField } from './code-field';
import { useLocale } from './locale';
import { ErrorNote, InvalidLink, Loading, Shell } from './shell';
import { useFlow } from './use-flow';
import { useLinkToken } from './use-link-token';

type Accepted = { membershipStatus: 'active' | 'pending_approval' };

/**
 * /i: accept a household invite. The API answers `start` the same for a
 * valid and an unknown invite, so the page cannot say which it was.
 */
export function InvitePage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('invite');
  const { state, run } = useFlow(RULES.invite);
  const [code, setCode] = useState('');
  const [accepted, setAccepted] = useState<Accepted | null>(null);

  if (link.state === 'reading') return <Loading />;
  if (link.state === 'missing' || state.step === 'dead') return <InvalidLink />;
  const { token } = link;

  const sendCode = () => {
    setCode('');
    void run(() => post('invites/accept/start', { token }, locale), 'code');
  };

  if (state.step === 'done') {
    const pending = accepted?.membershipStatus === 'pending_approval';
    return (
      <Shell title={t(pending ? 'invite.done.pending.title' : 'invite.done.active.title')}>
        <p role="status">{t(pending ? 'invite.done.pending.body' : 'invite.done.active.body')}</p>
      </Shell>
    );
  }

  if (state.step === 'code') {
    return (
      <Shell title={t('invite.title')}>
        <p role="status">{t('invite.sent')}</p>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!isCode(code)) return;
            void run(() => post<Accepted>('invites/accept/complete', { token, code }, locale), 'done', setAccepted);
          }}
        >
          <CodeField value={code} onChange={setCode} disabled={state.busy} />
          <ErrorNote code={state.error} />
          <button type="submit" className="button" disabled={state.busy || !isCode(code)}>
            {t('invite.accept')}
          </button>
          <button type="button" className="button button--quiet" disabled={state.busy} onClick={sendCode}>
            {t('common.resend')}
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title={t('invite.title')}>
      <p>{t('invite.intro')}</p>
      <ErrorNote code={state.error} />
      <button type="button" className="button" disabled={state.busy} onClick={sendCode}>
        {t('invite.send')}
      </button>
    </Shell>
  );
}
