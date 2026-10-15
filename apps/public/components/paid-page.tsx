'use client';

import { useEffect } from 'react';
import { useLocale } from './locale';
import { Shell } from './shell';

/**
 * /paid (ADR 0046): where Paymob's hosted checkout returns. Its query string
 * (the transaction's fields) proves nothing and is taken out of the address
 * bar at once; the app learns the result from the API, which the Paymob
 * webhook alone settles.
 */
export function PaidPage() {
  const { t } = useLocale();
  useEffect(() => {
    if (window.location.search || window.location.hash)
      window.history.replaceState(null, '', window.location.pathname);
  }, []);
  return (
    <Shell title={t('paid.title')}>
      <p>{t('paid.body')}</p>
    </Shell>
  );
}
