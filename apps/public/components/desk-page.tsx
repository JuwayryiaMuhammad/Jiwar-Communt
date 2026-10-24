'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { post } from '@/lib/client';
import { CANCEL_REASONS, DECLINE_REASONS, deskActions, deskOrder, fromLocalInput, type DeskAction, type DeskRequest, type DeskView } from '@/lib/desk';
import { fieldErrorKey, type FieldError } from '@/lib/errors';
import type { MessageKey } from '@/messages/ar';
import { useLocale } from './locale';
import { Qr } from './qr';
import { ErrorNote, InvalidLink, Loading, Shell } from './shell';
import { useLinkToken } from './use-link-token';

type Lookup = { state: 'loading' } | { state: 'dead' } | { state: 'failed'; code: string } | { state: 'ok'; view: DeskView };

/** One field with its label and its own errors. */
function Field({ label, errors, name, children }: { label: string; errors: FieldError[]; name: string; children: (id: string) => React.ReactNode }) {
  const { t } = useLocale();
  const id = useId();
  const mine = errors.filter((e) => e.field === name);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {mine.length ? <p className="note note--error">{mine.map((e) => t(fieldErrorKey(e.code), e.params)).join(' ')}</p> : null}
    </div>
  );
}

/**
 * One answer to a request: what it needs, then a confirming press. Nothing
 * is sent before it (README: a confirming press before any change).
 */
function Answer({
  token,
  request,
  action,
  onDone,
  onClose,
}: {
  token: string;
  request: DeskRequest;
  action: DeskAction;
  onDone: (next: DeskRequest) => void;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const [staffCount, setStaffCount] = useState('1');
  const [reason, setReason] = useState<string>(action === 'cancel' ? CANCEL_REASONS[0] : DECLINE_REASONS[0]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldError[]>([]);
  const body = (): object | null => {
    if (action === 'accept') return { staffCount: Number(staffCount) };
    if (action === 'decline' || action === 'cancel') return { reasonCode: reason };
    if (action === 'propose') {
      const windowStartsAt = fromLocalInput(from);
      const windowEndsAt = fromLocalInput(to);
      return windowStartsAt && windowEndsAt ? { windowStartsAt, windowEndsAt, staffCount: Number(staffCount) } : null;
    }
    return {};
  };
  const send = async () => {
    const payload = body();
    if (!payload || busy) return;
    setBusy(true);
    setError(null);
    setFields([]);
    const result = await post<DeskRequest>(`public/partner-desk/requests/${request.id}/${action}`, { token, ...payload }, locale);
    setBusy(false);
    if (result.ok) onDone(result.data);
    else {
      setError(result.code);
      setFields(result.fields);
    }
  };
  const reasons = action === 'cancel' ? CANCEL_REASONS : DECLINE_REASONS;
  return (
    <section className="confirm">
      {action === 'accept' || action === 'propose' ? (
        <Field label={t('desk.staffCount')} errors={fields} name="staffCount">
          {(id) => (
            <select id={id} className="input" value={staffCount} disabled={busy} onChange={(e) => setStaffCount(e.target.value)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      {action === 'propose' ? (
        <>
          <Field label={t('desk.from')} errors={fields} name="windowStartsAt">
            {(id) => <input id={id} className="input" type="datetime-local" dir="ltr" value={from} disabled={busy} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label={t('desk.to')} errors={fields} name="windowEndsAt">
            {(id) => <input id={id} className="input" type="datetime-local" dir="ltr" value={to} disabled={busy} onChange={(e) => setTo(e.target.value)} />}
          </Field>
        </>
      ) : null}
      {action === 'decline' || action === 'cancel' ? (
        <Field label={t('desk.reason')} errors={fields} name="reasonCode">
          {(id) => (
            <select id={id} className="input" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)}>
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {t(`desk.reason.${r}` as MessageKey)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      <ErrorNote code={error} />
      <button type="button" className={`button${action === 'decline' || action === 'cancel' ? ' button--danger' : ''}`} disabled={busy || !body()} onClick={() => void send()}>
        {t('desk.confirm')}
      </button>
      <button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>
        {t('common.cancel')}
      </button>
    </section>
  );
}

function RequestCard({ token, request, timeZone, onChanged }: { token: string; request: DeskRequest; timeZone: string; onChanged: (r: DeskRequest) => void }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState<DeskAction | null>(null);
  const when = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const date = (iso: string | null) => {
    if (!iso) return '';
    try {
      return when.format(new Date(iso));
    } catch {
      return iso;
    }
  };
  const what = `${t(`desk.cat.${request.category}` as MessageKey)}${request.subcategory ? ` · ${locale === 'ar' ? request.subcategory.nameAr : request.subcategory.nameEn}` : ''}`;
  return (
    <article className="card card--inner">
      <h2 className="card__subtitle">
        <span dir="ltr">{request.number}</span> · {what}
      </h2>
      <p className="state" role="status">
        {t(`desk.status.${request.status}` as MessageKey)}
        {request.closeReason ? ` · ${t(`desk.reason.${request.closeReason}` as MessageKey)}` : ''}
      </p>
      {request.consentWithdrawn ? <p className="note">{t('desk.withdrawn')}</p> : null}
      <dl className="facts">
        {request.unitCode ? (
          <>
            <dt>{t('desk.unit')}</dt>
            <dd dir="ltr">{request.unitCode}</dd>
          </>
        ) : null}
        {request.firstName ? (
          <>
            <dt>{t('desk.name')}</dt>
            <dd>{request.firstName}</dd>
          </>
        ) : null}
        <dt>{t('desk.when')}</dt>
        <dd>
          {date(request.askedStartsAt)} – {date(request.askedEndsAt)}
        </dd>
        {request.proposedStartsAt ? (
          <>
            <dt>{t('desk.proposed')}</dt>
            <dd>
              {date(request.proposedStartsAt)} – {date(request.proposedEndsAt)}
            </dd>
          </>
        ) : null}
        {request.agreedStartsAt ? (
          <>
            <dt>{t('desk.agreed')}</dt>
            <dd>
              {date(request.agreedStartsAt)} – {date(request.agreedEndsAt)}
            </dd>
            <dt>{t('desk.staff')}</dt>
            <dd>{request.staffCount}</dd>
          </>
        ) : null}
        {request.note ? (
          <>
            <dt>{t('desk.note')}</dt>
            <dd dir="auto">{request.note}</dd>
          </>
        ) : null}
        {request.items.length ? (
          <>
            <dt>{t('desk.items')}</dt>
            <dd>
              {request.items.map((i, n) => (
                <span key={n} className="window">
                  {i.quantity} × {locale === 'ar' ? i.nameAr : i.nameEn} ({i.price})
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      {request.pass ? (
        <section>
          <h3 className="card__subtitle">{t('desk.pass')}</h3>
          {request.pass.qrPayload ? <Qr payload={request.pass.qrPayload} label={t('desk.pass')} /> : null}
          {request.pass.code ? (
            <div className="gate-code">
              <span className="gate-code__label">{t('desk.pass.code')}</span>
              <span className="gate-code__digits" dir="ltr">
                {request.pass.code}
              </span>
              <span className="hint">{t('desk.pass.hint')}</span>
            </div>
          ) : null}
        </section>
      ) : request.status === 'accepted' && request.gatePass ? (
        <p className="hint">{t('desk.pass.later')}</p>
      ) : null}
      {open ? (
        <Answer
          token={token}
          request={request}
          action={open}
          onClose={() => setOpen(null)}
          onDone={(next) => {
            setOpen(null);
            onChanged(next);
          }}
        />
      ) : (
        <div className="actions">
          {deskActions(request).map((a) => (
            <button key={a} type="button" className={`button${a === 'decline' || a === 'cancel' ? ' button--quiet' : ''}`} onClick={() => setOpen(a)}>
              {t(`desk.action.${a}` as MessageKey)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * /p (ADR 0060): a partner's desk, opened from the link the management
 * gave it. Its live requests and those closed today, with exactly what
 * each needs; its answers, each after a confirming press. Only what the
 * API returns.
 */
export function DeskPage() {
  const { t } = useLocale();
  const link = useLinkToken('desk');
  const token = link.state === 'ready' ? link.token : null;
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!token) return;
    let current = true;
    setLookup({ state: 'loading' });
    void post<DeskView>('public/partner-desk/lookup', { token }, 'ar').then((result) => {
      if (!current) return;
      if (result.ok) setLookup({ state: 'ok', view: result.data });
      else if (result.code === 'PARTNER_DESK_NOT_FOUND') setLookup({ state: 'dead' });
      else setLookup({ state: 'failed', code: result.code });
    });
    return () => {
      current = false;
    };
  }, [token, attempt]);

  if (link.state === 'reading') return <Loading />;
  if (!token || lookup.state === 'dead') return <InvalidLink />;
  if (lookup.state === 'loading') return <Loading />;
  if (lookup.state === 'failed')
    return (
      <Shell title={t('desk.title')}>
        <ErrorNote code={lookup.code} />
        <button type="button" className="button" onClick={refresh}>
          {t('common.retry')}
        </button>
      </Shell>
    );
  const { view } = lookup;
  const replace = (next: DeskRequest) =>
    setLookup({ state: 'ok', view: { ...view, requests: view.requests.map((r) => (r.id === next.id ? next : r)) } });
  const requests = deskOrder(view.requests);
  return (
    <Shell title={`${t('desk.title')} · ${view.partner.nameAr}`}>
      <p className="muted">
        {t('desk.compound')}: {view.compoundName}
      </p>
      <p className="hint">{t('desk.timezone', { tz: view.timeZone })}</p>
      <button type="button" className="button button--quiet" onClick={refresh}>
        {t('desk.refresh')}
      </button>
      {requests.length === 0 ? <p>{t('desk.empty')}</p> : null}
      {requests.map((r) => (
        <RequestCard key={r.id} token={token} request={r} timeZone={view.timeZone} onChanged={replace} />
      ))}
    </Shell>
  );
}
