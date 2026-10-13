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

/** A presigned link is opened, never kept: only http(s) is followed. */
function open(url: string) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:') window.location.assign(url);
  } catch {
    // Not a URL: nothing to open.
  }
}

/**
 * /a/export (ADR 0036): the link alone downloads nothing. A code goes to the
 * same email, and each download needs a new one.
 */
export function ExportPage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('action');
  const { state, run, dispatch } = useFlow(RULES.export);
  const [code, setCode] = useState('');

  if (link.state === 'reading') return <Loading />;
  if (link.state === 'missing' || state.step === 'dead') return <InvalidLink />;
  const { token } = link;

  const sendCode = () => {
    setCode('');
    void run(() => post('public/data-exports/code', { token }, locale), 'code');
  };

  if (state.step === 'done') {
    return (
      <Shell title={t('export.done.title')}>
        <p role="status">{t('export.done.body')}</p>
        <p className="muted">{t('export.done.blocked')}</p>
        <p className="muted">{t('export.limit')}</p>
        <button type="button" className="button button--quiet" onClick={() => dispatch({ type: 'restart' })}>
          {t('export.again')}
        </button>
      </Shell>
    );
  }

  if (state.step === 'code') {
    return (
      <Shell title={t('export.title')}>
        <p role="status">{t('export.sent')}</p>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!isCode(code)) return;
            void run(
              () => post<{ url: string }>('public/data-exports/download', { token, code }, locale),
              'done',
              (data) => {
                setCode('');
                open(data.url);
              },
            );
          }}
        >
          <CodeField value={code} onChange={setCode} disabled={state.busy} />
          <ErrorNote code={state.error} />
          <button type="submit" className="button" disabled={state.busy || !isCode(code)}>
            {t('export.download')}
          </button>
          <button type="button" className="button button--quiet" disabled={state.busy} onClick={sendCode}>
            {t('common.resend')}
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title={t('export.title')}>
      <p>{t('export.intro')}</p>
      <p className="muted">{t('export.limit')}</p>
      <ErrorNote code={state.error} />
      <button type="button" className="button" disabled={state.busy} onClick={sendCode}>
        {t('export.send')}
      </button>
    </Shell>
  );
}
