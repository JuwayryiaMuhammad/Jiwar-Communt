'use client';

import { useLocale } from './locale';
import { Shell } from './shell';

export function LandingPage() {
  const { t } = useLocale();
  return (
    <Shell title={t('landing.title')}>
      <p>{t('landing.body')}</p>
      <h2 className="card__subtitle">{t('landing.download')}</h2>
      <ul className="stores">
        {(['landing.ios', 'landing.android'] as const).map((store) => (
          <li key={store} className="store" aria-disabled="true">
            <span>{t(store)}</span>
            <span className="muted">{t('landing.soon')}</span>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
