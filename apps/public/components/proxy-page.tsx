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

/**
 * /x: accept an owner's invitation to look after their unit (ADR 0063), as
 * a household invite is accepted (/i): a code to the invited email, then
 * the code. The API answers `start` the same for a valid and an unknown
 * invite, so the page cannot say which it was.
 */
export function ProxyPage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('proxyInvite');
  const { state, run } = useFlow(RULES.proxyInvite);
  const [code, setCode] = useState('');

  if (link.state === 'reading') return <Loading />;
  if (link.state === 'missing' || state.step === 'dead') return <InvalidLink />;
  const { token } = link;

  const sendCode = () => {
    setCode('');
    void run(() => post('proxy-invites/accept/start', { token }, locale), 'code');
  };

  if (state.step === 'done') {
    return (
      <Shell title={t('proxy.done.title')}>
        <p role="status">{t('proxy.done.body')}</p>
      </Shell>
    );
  }

  if (state.step === 'code') {
    return (
      <Shell title={t('proxy.title')}>
        <p role="status">{t('proxy.sent')}</p>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!isCode(code)) return;
            void run(() => post('proxy-invites/accept/complete', { token, code }, locale), 'done');
          }}
        >
          <CodeField value={code} onChange={setCode} disabled={state.busy} />
          <ErrorNote code={state.error} />
          <button type="submit" className="button" disabled={state.busy || !isCode(code)}>
            {t('proxy.accept')}
          </button>
          <button type="button" className="button button--quiet" disabled={state.busy} onClick={sendCode}>
            {t('common.resend')}
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title={t('proxy.title')}>
      <p>{t('proxy.intro')}</p>
      <ErrorNote code={state.error} />
      <button type="button" className="button" disabled={state.busy} onClick={sendCode}>
        {t('proxy.send')}
      </button>
    </Shell>
  );
}
