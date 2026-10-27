'use client';

import { useEffect, useId, useState } from 'react';
import { parseFragment } from '@/lib/fragment';
import { post } from '@/lib/client';
import { useLocale } from './locale';
import { ErrorNote, Loading, Shell } from './shell';
import { useLinkToken } from './use-link-token';

interface ClearanceView {
  compoundName: string;
  number: string;
  unitCode: string;
  asOf: string;
  /** The compound's local date, YYYY-MM-DD. */
  validUntil: string;
  status: 'valid' | 'expired';
}

type Lookup =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed'; code: string }
  | { state: 'ok'; view: ClearanceView };

/**
 * /c (ADR 0062): whether a clearance certificate stands, for whoever the
 * holder shows it to. Only what the API returns — the compound, the number,
 * the unit's code and the dates; never a name. The code comes in the
 * fragment (stripped at once) or is typed from the printed certificate,
 * which shows this page's address and the code apart.
 */
export function ClearancePage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('clearance');
  const [typed, setTyped] = useState<string | null>(null);
  const code = link.state === 'ready' ? link.token : typed;
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!code) return;
    let current = true;
    setLookup({ state: 'loading' });
    void post<ClearanceView>('public/clearances/lookup', { code }, 'ar').then((result) => {
      if (!current) return;
      if (result.ok) setLookup({ state: 'ok', view: result.data });
      else if (result.code === 'CLEARANCE_NOT_FOUND') setLookup({ state: 'missing' });
      else setLookup({ state: 'failed', code: result.code });
    });
    return () => {
      current = false;
    };
  }, [code, attempt]);

  if (link.state === 'reading') return <Loading />;
  if (!code) return <CodeForm onCode={setTyped} />;
  if (lookup.state === 'loading') return <Loading />;
  if (lookup.state === 'missing') {
    return (
      <Shell title={t('clearance.title')}>
        <p>{t('clearance.notfound')}</p>
        <button type="button" className="button" onClick={() => setTyped(null)}>
          {t('clearance.another')}
        </button>
      </Shell>
    );
  }
  if (lookup.state === 'failed') {
    return (
      <Shell title={t('clearance.title')}>
        <ErrorNote code={lookup.code} />
        <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
          {t('common.retry')}
        </button>
      </Shell>
    );
  }

  const { view } = lookup;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  return (
    <Shell title={t('clearance.title')}>
      <p className={`state state--${view.status === 'valid' ? 'ok' : 'off'}`} role="status">
        {t(view.status === 'valid' ? 'clearance.valid' : 'clearance.expired')}
      </p>
      <dl className="facts">
        <dt>{t('clearance.compound')}</dt>
        <dd>{view.compoundName}</dd>
        <dt>{t('clearance.number')}</dt>
        <dd dir="ltr">{view.number}</dd>
        <dt>{t('clearance.unit')}</dt>
        <dd dir="ltr">{view.unitCode}</dd>
        <dt>{t('clearance.asOf')}</dt>
        <dd dir="ltr">{when(view.asOf)}</dd>
        <dt>{t('clearance.validUntil')}</dt>
        <dd dir="ltr">{view.validUntil}</dd>
      </dl>
    </Shell>
  );
}

function CodeForm({ onCode }: { onCode: (code: string) => void }) {
  const { t } = useLocale();
  const id = useId();
  const [value, setValue] = useState('');
  const code = parseFragment(value.trim(), 'clearance');
  return (
    <Shell title={t('clearance.title')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code) onCode(code);
        }}
      >
        <div className="field">
          <label htmlFor={id}>{t('clearance.code')}</label>
          <input
            id={id}
            className="input"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
          <p className="hint">{t('clearance.code.hint')}</p>
        </div>
        <button type="submit" className="button" disabled={!code}>
          {t('clearance.check')}
        </button>
      </form>
    </Shell>
  );
}
