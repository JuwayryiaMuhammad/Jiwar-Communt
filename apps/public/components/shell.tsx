'use client';

import { errorKey } from '@/lib/errors';
import { useLocale } from './locale';

/** The frame of every page: the app name, the language switch, one card. */
export function Shell({ title, children }: { title?: string; children: React.ReactNode }) {
  const { t, toggle, locale } = useLocale();
  return (
    <div className="page">
      <header className="bar">
        <span className="bar__name">{t('app.name')}</span>
        <button type="button" className="bar__lang" onClick={toggle} lang={locale === 'ar' ? 'en' : 'ar'}>
          {t('lang.switch')}
        </button>
      </header>
      <main className="card">
        {title ? <h1 className="card__title">{title}</h1> : null}
        {children}
      </main>
    </div>
  );
}

export function InvalidLink() {
  const { t } = useLocale();
  return (
    <Shell title={t('invalid.title')}>
      <p>{t('invalid.body')}</p>
      <p className="muted">{t('invalid.hint')}</p>
    </Shell>
  );
}

export function Loading() {
  const { t } = useLocale();
  return (
    <Shell>
      <p className="muted" role="status">
        {t('common.loading')}
      </p>
    </Shell>
  );
}

/** An API error code, translated; announced when it appears. */
export function ErrorNote({ code }: { code: string | null }) {
  const { t } = useLocale();
  return (
    <div role="alert" aria-live="assertive">
      {code ? <p className="note note--error">{t(errorKey(code))}</p> : null}
    </div>
  );
}
