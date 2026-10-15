'use client';

import { useEffect, useState } from 'react';
import { post } from '@/lib/client';
import { useLocale } from './locale';
import { ErrorNote, InvalidLink, Loading, Shell } from './shell';
import { useLinkToken } from './use-link-token';

interface ReceiptView {
  compoundName: string;
  receiptNumber: string;
  amount: string;
  currency: string;
  paidOn: string;
  status: 'valid' | 'reversed';
}

type Lookup =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed'; code: string }
  | { state: 'ok'; view: ReceiptView };

/**
 * /receipt (ADR 0046): whether a receipt stands. Only what the API returns —
 * the compound, the number, the amount, the day and the status; never a
 * name or a unit. The code lives in the fragment and is stripped at once.
 */
export function ReceiptPage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('receipt');
  const code = link.state === 'ready' ? link.token : null;
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!code) return;
    let current = true;
    setLookup({ state: 'loading' });
    void post<ReceiptView>('public/receipts/lookup', { code }, 'ar').then((result) => {
      if (!current) return;
      if (result.ok) setLookup({ state: 'ok', view: result.data });
      else if (result.code === 'RECEIPT_NOT_FOUND') setLookup({ state: 'missing' });
      else setLookup({ state: 'failed', code: result.code });
    });
    return () => {
      current = false;
    };
  }, [code, attempt]);

  if (link.state === 'reading') return <Loading />;
  if (!code) return <InvalidLink />;
  if (lookup.state === 'loading') return <Loading />;
  if (lookup.state === 'missing') {
    return (
      <Shell title={t('receipt.title')}>
        <p>{t('receipt.notfound')}</p>
        <p className="muted">{t('receipt.notfound.hint')}</p>
      </Shell>
    );
  }
  if (lookup.state === 'failed') {
    return (
      <Shell title={t('receipt.title')}>
        <ErrorNote code={lookup.code} />
        <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
          {t('common.retry')}
        </button>
      </Shell>
    );
  }

  const { view } = lookup;
  const amount = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-EG', {
    style: 'currency',
    currency: view.currency,
  }).format(Number(view.amount));
  return (
    <Shell title={t('receipt.title')}>
      <p className={`state state--${view.status === 'valid' ? 'ok' : 'off'}`} role="status">
        {t(view.status === 'valid' ? 'receipt.valid' : 'receipt.reversed')}
      </p>
      <dl className="facts">
        <dt>{t('receipt.compound')}</dt>
        <dd>{view.compoundName}</dd>
        <dt>{t('receipt.number')}</dt>
        <dd dir="ltr">{view.receiptNumber}</dd>
        <dt>{t('receipt.amount')}</dt>
        <dd dir="ltr">{amount}</dd>
        <dt>{t('receipt.paidOn')}</dt>
        <dd dir="ltr">{view.paidOn}</dd>
      </dl>
    </Shell>
  );
}
