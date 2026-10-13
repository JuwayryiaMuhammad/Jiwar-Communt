'use client';

import { useEffect, useState } from 'react';
import { post } from '@/lib/client';
import { RULES } from '@/lib/flow';
import { passState, type PassView } from '@/lib/pass-status';
import type { MessageKey } from '@/messages/ar';
import { useLocale } from './locale';
import { Qr } from './qr';
import { ErrorNote, InvalidLink, Loading, Shell } from './shell';
import { useFlow } from './use-flow';
import { useLinkToken } from './use-link-token';

type Lookup = { state: 'loading' } | { state: 'dead' } | { state: 'failed'; code: string } | { state: 'ok'; view: PassView };

/** /v (ADR 0030): what the visitor shows at the gate. Only what the API returns. */
export function VisitorPage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('visitor');
  const token = link.state === 'ready' ? link.token : null;
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [asking, setAsking] = useState(false);
  const notMe = useFlow(RULES.visitorNotMe);

  useEffect(() => {
    if (!token) return;
    let current = true;
    setLookup({ state: 'loading' });
    // The lookup has no language: the page translates what comes back.
    void post<PassView>('public/visitor-passes/lookup', { token }, 'ar').then((result) => {
      if (!current) return;
      if (result.ok) setLookup({ state: 'ok', view: result.data });
      else if (result.code === 'VISITOR_PASS_NOT_FOUND') setLookup({ state: 'dead' });
      else setLookup({ state: 'failed', code: result.code });
    });
    return () => {
      current = false;
    };
  }, [token, attempt]);

  // The window and the schedule are judged against the clock as it moves.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (link.state === 'reading') return <Loading />;
  if (!token || lookup.state === 'dead' || notMe.state.step === 'dead') return <InvalidLink />;
  if (lookup.state === 'loading') return <Loading />;
  if (lookup.state === 'failed') {
    return (
      <Shell title={t('visitor.title')}>
        <ErrorNote code={lookup.code} />
        <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
          {t('common.retry')}
        </button>
      </Shell>
    );
  }
  if (notMe.state.step === 'done') {
    return (
      <Shell title={t('visitor.title')}>
        <p role="status">{t('visitor.notme.done')}</p>
      </Shell>
    );
  }

  const { view } = lookup;
  const state = passState(view, now);
  const live = view.status === 'active';
  const when = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    timeZone: view.timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const date = (iso: string) => {
    try {
      return when.format(new Date(iso));
    } catch {
      return iso;
    }
  };

  return (
    <Shell title={t('visitor.title')}>
      <p className={`state state--${state === 'active' ? 'ok' : live ? 'wait' : 'off'}`} role="status">
        {t(`visitor.state.${state}` satisfies MessageKey)}
      </p>

      {live && view.qrPayload ? <Qr payload={view.qrPayload} label={t('visitor.qr.alt')} /> : null}
      {live && view.code ? (
        <div className="gate-code">
          <span className="gate-code__label">{t('visitor.code')}</span>
          <span className="gate-code__digits" dir="ltr">
            {view.code}
          </span>
          <span className="hint">{t('visitor.code.hint')}</span>
        </div>
      ) : null}

      <dl className="facts">
        <dt>{t('visitor.compound')}</dt>
        <dd>{view.compoundName}</dd>
        <dt>{t('visitor.unit')}</dt>
        <dd dir="ltr">{view.unitCode}</dd>
        <dt>{t('visitor.kind')}</dt>
        <dd>{t(`visitor.kind.${view.kind}` satisfies MessageKey)}</dd>
        <dt>{t('visitor.party')}</dt>
        <dd>{view.partySize}</dd>
        <dt>{t('visitor.from')}</dt>
        <dd>{date(view.validFrom)}</dd>
        <dt>{t('visitor.until')}</dt>
        <dd>{date(view.validUntil)}</dd>
        {view.schedule ? (
          <>
            <dt>{t('visitor.schedule')}</dt>
            <dd>
              {view.schedule.days.map((day) => t(`day.${day}` as MessageKey)).join(locale === 'ar' ? '، ' : ', ')}
              {view.schedule.windows.map((w) => (
                <span key={`${w.from}-${w.to}`} className="window" dir="ltr">
                  {w.from} – {w.to}
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      <p className="hint">{t('visitor.timezone', { tz: view.timeZone })}</p>

      {view.visitorDirections ? (
        <section>
          <h2 className="card__subtitle">{t('visitor.directions')}</h2>
          <p className="directions" dir="auto">
            {view.visitorDirections}
          </p>
        </section>
      ) : null}
      {view.emergencyPhone ? (
        <p>
          {t('visitor.emergency')}:{' '}
          <a href={`tel:${view.emergencyPhone}`} dir="ltr">
            {view.emergencyPhone}
          </a>
        </p>
      ) : null}

      {live ? (
        asking ? (
          <section className="confirm" aria-labelledby="not-me-title">
            <h2 id="not-me-title" className="card__subtitle">
              {t('visitor.notme.title')}
            </h2>
            <p>{t('visitor.notme.body')}</p>
            <ErrorNote code={notMe.state.error} />
            <button
              type="button"
              className="button button--danger"
              disabled={notMe.state.busy}
              onClick={() => void notMe.run(() => post('public/visitor-passes/not-me', { token }, locale), 'done')}
            >
              {t('visitor.notme.confirm')}
            </button>
            <button type="button" className="button button--quiet" disabled={notMe.state.busy} onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </button>
          </section>
        ) : (
          <button type="button" className="link" onClick={() => setAsking(true)}>
            {t('visitor.notme.link')}
          </button>
        )
      ) : null}
    </Shell>
  );
}
