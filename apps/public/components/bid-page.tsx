'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  BID_DOCUMENT_TYPES,
  BID_LIMITS,
  bidActions,
  bidBody,
  documentHref,
  documentRefusal,
  liveBid,
  sendableDocuments,
  type BidDocument,
  type BidForm,
  type BidLinkPage,
} from '@/lib/bid';
import { post } from '@/lib/client';
import { fieldErrorKey, type FieldError } from '@/lib/errors';
import type { MessageKey } from '@/messages/ar';
import { useLocale } from './locale';
import { ErrorNote, InvalidLink, Loading, Shell } from './shell';
import { useLinkToken } from './use-link-token';

type Lookup = { state: 'loading' } | { state: 'dead' } | { state: 'failed'; code: string } | { state: 'ok'; page: BidLinkPage };

/** Every answer that opens nothing is this one 404 (ADR 0088). */
const DEAD = 'TENDER_LINK_NOT_FOUND';

function Field({ label, hint, errors, name, children }: { label: string; hint?: string; errors: FieldError[]; name: string; children: (id: string) => React.ReactNode }) {
  const { t } = useLocale();
  const id = useId();
  const mine = errors.filter((e) => e.field === name);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <p className="hint">{hint}</p> : null}
      {mine.length ? <p className="note note--error">{mine.map((e) => t(fieldErrorKey(e.code), e.params)).join(' ')}</p> : null}
    </div>
  );
}

type UploadView = { document: BidDocument; upload: { url: string; method: 'PUT'; headers: Record<string, string> } };

/**
 * The bid's documents before it is sent: each named, uploaded straight to
 * storage with the URL the API signed, then finalized; a draft removed.
 * Nobody reads them before the opening, the company included: no link.
 */
function Drafts({ token, page, onChanged, onDead }: { token: string; page: BidLinkPage; onChanged: () => void; onDead: () => void }) {
  const { t, locale } = useLocale();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const drafts = page.bidDocuments.filter((d) => !d.sent);
  const full = page.bidDocuments.length >= page.maxBidDocuments;
  const fail = (code: string) => {
    if (code === DEAD) onDead();
    else setError(code);
  };
  const upload = async (file: File) => {
    setError(null);
    const refused = documentRefusal(file);
    if (refused) return setError(refused);
    setBusy('upload');
    try {
      const declared = await post<UploadView>(
        'public/tender-bids/uploads',
        { token, title: title.trim(), contentType: file.type, size: file.size },
        locale,
      );
      if (!declared.ok) return fail(declared.code);
      let put: Response;
      try {
        put = await fetch(declared.data.upload.url, {
          method: declared.data.upload.method,
          headers: declared.data.upload.headers,
          body: file,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
      } catch {
        return setError('STORAGE_UNAVAILABLE');
      }
      if (!put.ok) return setError('STORAGE_UNAVAILABLE');
      const done = await post(`public/tender-bids/documents/${declared.data.document.id}/finalize`, { token }, locale);
      if (!done.ok) return fail(done.code);
      setTitle('');
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
      onChanged();
    }
  };
  const remove = async (id: string) => {
    setError(null);
    setBusy(`remove:${id}`);
    const done = await post(`public/tender-bids/documents/${id}/remove`, { token }, locale);
    setBusy(null);
    if (!done.ok) fail(done.code);
    onChanged();
  };
  return (
    <section>
      <h3 className="card__subtitle">{t('bid.docs.title')}</h3>
      <p className="hint">{t('bid.docs.hint', { max: page.maxBidDocuments })}</p>
      {drafts.length ? (
        <ul className="list">
          {drafts.map((d) => (
            <li key={d.id}>
              <span dir="auto">{d.title}</span>
              {d.ready ? null : <span className="muted"> · {t('bid.docs.notArrived')}</span>}{' '}
              <button type="button" className="button button--quiet" disabled={busy !== null} onClick={() => void remove(d.id)}>
                {t('bid.docs.remove')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('bid.docs.none')}</p>
      )}
      {full ? (
        <p className="note">{t('bid.docs.full')}</p>
      ) : (
        <>
          <Field label={t('bid.docs.name')} hint={t('bid.docs.name.hint')} errors={[]} name="title">
            {(id) => (
              <input
                id={id}
                className="input"
                dir="auto"
                maxLength={BID_LIMITS.documentTitle.max}
                value={title}
                disabled={busy !== null}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Field>
          <input
            ref={input}
            type="file"
            hidden
            accept={BID_DOCUMENT_TYPES.join(',')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <button type="button" className="button button--quiet" disabled={busy !== null || !title.trim()} onClick={() => input.current?.click()}>
            {busy === 'upload' ? t('common.loading') : t('bid.docs.add')}
          </button>
        </>
      )}
      <ErrorNote code={error} />
    </section>
  );
}

/** The sealed bid: its form, then a confirming press. */
function SendBid({
  token,
  page,
  onDone,
  onDead,
  onChanged,
}: {
  token: string;
  page: BidLinkPage;
  onDone: (next: BidLinkPage) => void;
  onDead: () => void;
  onChanged: () => void;
}) {
  const { t, locale } = useLocale();
  const [form, setForm] = useState<BidForm>({ amount: '', durationDays: '', note: '' });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldError[]>([]);
  const fileIds = sendableDocuments(page);
  const body = bidBody(form, fileIds);
  const set = (key: keyof BidForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm({ ...form, [key]: e.target.value });
    setConfirming(false);
  };
  const send = async () => {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    setFields([]);
    const result = await post<BidLinkPage>('public/tender-bids/bid', { token, ...body }, locale);
    setBusy(false);
    if (result.ok) return onDone(result.data);
    if (result.code === DEAD) return onDead();
    setConfirming(false);
    setError(result.code);
    setFields(result.fields);
  };
  return (
    <section className="confirm">
      <h2 className="card__subtitle">{t('bid.send.title')}</h2>
      <p className="hint">{t('bid.sealed')}</p>
      <Field label={t('bid.amount')} hint={t('bid.amount.hint')} errors={fields} name="amount">
        {(id) => <input id={id} className="input" inputMode="decimal" dir="ltr" autoComplete="off" value={form.amount} disabled={busy} onChange={set('amount')} />}
      </Field>
      <Field label={t('bid.duration')} hint={t('bid.duration.hint', { max: BID_LIMITS.durationDays.max })} errors={fields} name="durationDays">
        {(id) => <input id={id} className="input" inputMode="numeric" dir="ltr" autoComplete="off" value={form.durationDays} disabled={busy} onChange={set('durationDays')} />}
      </Field>
      <Field label={t('bid.note')} hint={t('bid.note.hint', { max: BID_LIMITS.note.max })} errors={fields} name="note">
        {(id) => <textarea id={id} className="input" dir="auto" rows={5} maxLength={BID_LIMITS.note.max} value={form.note} disabled={busy} onChange={set('note')} />}
      </Field>
      <Drafts token={token} page={page} onChanged={onChanged} onDead={onDead} />
      <ErrorNote code={error} />
      {confirming ? (
        <>
          <p className="note">{t('bid.confirm.body', { amount: body?.amount ?? '' })}</p>
          <p className="note">{t('bid.confirm.documents', { count: fileIds.length })}</p>
          <button type="button" className="button" disabled={busy || !body} onClick={() => void send()}>
            {t('bid.confirm')}
          </button>
          <button type="button" className="button button--quiet" disabled={busy} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </>
      ) : (
        <button type="button" className="button" disabled={!body} onClick={() => setConfirming(true)}>
          {t('bid.send')}
        </button>
      )}
    </section>
  );
}

/** Withdrawing the live bid, after a confirming press. */
function Withdraw({ token, onDone, onDead }: { token: string; onDone: () => void; onDead: () => void }) {
  const { t, locale } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await post('public/tender-bids/withdraw', { token }, locale);
    setBusy(false);
    if (result.ok) return onDone();
    if (result.code === DEAD) return onDead();
    setConfirming(false);
    setError(result.code);
  };
  return (
    <section className="confirm">
      <ErrorNote code={error} />
      {confirming ? (
        <>
          <p className="note">{t('bid.withdraw.body')}</p>
          <button type="button" className="button button--danger" disabled={busy} onClick={() => void send()}>
            {t('bid.withdraw.confirm')}
          </button>
          <button type="button" className="button button--quiet" disabled={busy} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </>
      ) : (
        <button type="button" className="button button--quiet" onClick={() => setConfirming(true)}>
          {t('bid.withdraw')}
        </button>
      )}
    </section>
  );
}

/**
 * /b (ADR 0088): a company that is not registered, invited to one tender
 * by its bid link. The tender and its documents; a sealed bid (amount,
 * days, terms), one live at a time, withdrawn before the deadline. The
 * link is the only credential; only what the API returns.
 */
export function BidPage() {
  const { t, locale, format } = useLocale();
  const link = useLinkToken('bid');
  const token = link.state === 'ready' ? link.token : null;
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  /** Re-read after a document changed, keeping the form on screen. */
  const refreshQuiet = useCallback(() => {
    if (!token) return;
    void post<BidLinkPage>('public/tender-bids/lookup', { token }, 'ar').then((result) => {
      if (result.ok) setLookup({ state: 'ok', page: result.data });
      else if (result.code === DEAD) setLookup({ state: 'dead' });
    });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let current = true;
    setLookup({ state: 'loading' });
    void post<BidLinkPage>('public/tender-bids/lookup', { token }, 'ar').then((result) => {
      if (!current) return;
      if (result.ok) setLookup({ state: 'ok', page: result.data });
      else if (result.code === DEAD) setLookup({ state: 'dead' });
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
      <Shell title={t('bid.title')}>
        <ErrorNote code={lookup.code} />
        <button type="button" className="button" onClick={refresh}>
          {t('common.retry')}
        </button>
      </Shell>
    );
  const { page } = lookup;
  const dead = () => setLookup({ state: 'dead' });
  const when = (iso: string) => {
    try {
      return format().custom(iso, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return iso;
    }
  };
  const actions = bidActions(page);
  return (
    <Shell title={`${t('bid.title')} · ${page.title}`}>
      <p className="muted">
        {t('bid.compound')}: {page.compoundName}
        {page.companyName ? ` · ${t('bid.company')}: ${page.companyName}` : ''}
      </p>
      <p className={`state${page.status === 'open' ? ' state--ok' : page.status === 'closed' ? ' state--wait' : ' state--off'}`} role="status">
        {t(`bid.status.${page.status}` as MessageKey)}
        {page.outcome ? ` · ${t(`bid.outcome.${page.outcome}` as MessageKey)}` : ''}
      </p>
      <dl className="facts">
        <dt>{t('bid.reference')}</dt>
        <dd dir="ltr">{page.reference}</dd>
        <dt>{t('bid.category')}</dt>
        <dd>{t(`bid.cat.${page.category}` as MessageKey)}</dd>
        <dt>{t('bid.due')}</dt>
        <dd>{when(page.bidsDueAt)}</dd>
        {page.scope ? (
          <>
            <dt>{t('bid.scope')}</dt>
            <dd dir="auto">{page.scope}</dd>
          </>
        ) : null}
      </dl>
      <section>
        <h2 className="card__subtitle">{t('bid.documents')}</h2>
        {page.documents.length === 0 ? <p className="muted">{t('bid.documents.none')}</p> : null}
        <ul className="list">
          {page.documents.map((d) => {
            const href = documentHref(d.fileUrl);
            return (
              <li key={d.id}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" dir="auto">
                    {d.title}
                  </a>
                ) : (
                  <span dir="auto">{d.title}</span>
                )}
              </li>
            );
          })}
        </ul>
        {page.documents.length ? <p className="hint">{t('bid.documents.hint')}</p> : null}
      </section>
      {page.bid ? (
        <section>
          <h2 className="card__subtitle">{t('bid.mine')}</h2>
          <p className="note">
            {page.bid.withdrawnAt
              ? t('bid.mine.withdrawn', { at: when(page.bid.withdrawnAt) })
              : t('bid.mine.sent', { at: when(page.bid.submittedAt) })}
          </p>
          <p className="hint">{page.bid.sealed ? t('bid.mine.sealed') : t('bid.mine.opened', { amount: page.bid.amount ?? '' })}</p>
          {liveBid(page) && page.bidDocuments.some((d) => d.sent) ? (
            <>
              <p className="note">{t('bid.mine.documents')}</p>
              <ul className="list">
                {page.bidDocuments
                  .filter((d) => d.sent)
                  .map((d) => (
                    <li key={d.id} dir="auto">
                      {d.title}
                    </li>
                  ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
      {actions.includes('bid') ? (
        <SendBid token={token} page={page} onDead={dead} onChanged={refreshQuiet} onDone={(next) => setLookup({ state: 'ok', page: next })} />
      ) : null}
      {actions.includes('withdraw') && liveBid(page) ? <Withdraw token={token} onDead={dead} onDone={refresh} /> : null}
      <button type="button" className="button button--quiet" onClick={refresh}>
        {t('bid.refresh')}
      </button>
    </Shell>
  );
}
