'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { post } from '@/lib/client';
import type { MessageKey } from '@/messages/ar';
import { useLocale } from './locale';
import { ErrorNote, InvalidLink, Loading, Shell } from './shell';
import { useLinkToken } from './use-link-token';

type Kind = 'ownership_proof' | 'lease_proof' | 'other_proof';
const KINDS: Kind[] = ['ownership_proof', 'lease_proof', 'other_proof'];
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_BYTES = 10 * 1024 * 1024;

interface DocumentView {
  id: string;
  kind: Kind;
  contentType: string;
  ready: boolean;
  createdAt: string;
}

interface StatusView {
  compoundName: string;
  status: 'pending' | 'needs_correction';
  unitCode: string;
  correctionCodes: string[];
  documents: DocumentView[];
  maxDocuments: number;
}

interface UploadView {
  document: DocumentView;
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
}

type Lookup =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed'; code: string }
  | { state: 'ok'; view: StatusView };

/**
 * /rs (ADR 0062): a registrant's request, from the link emailed after they
 * registered. Its state, what the management asks to correct (codes only),
 * and the proof of their place in the unit: attach (PUT straight to
 * storage with the URL the API signed, then finalize), remove, and send
 * again after a correction. Every change waits for a press. Once the
 * request is decided the link opens nothing: the email told the outcome.
 */
export function RegistrationStatusPage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('registrationStatus');
  const token = link.state === 'ready' ? link.token : null;
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!token) return;
    let current = true;
    void post<StatusView>('public/registrations/status', { token }, 'ar').then((result) => {
      if (!current) return;
      if (result.ok) setLookup({ state: 'ok', view: result.data });
      else if (result.code === 'REGISTRATION_STATUS_NOT_FOUND') setLookup({ state: 'missing' });
      else setLookup({ state: 'failed', code: result.code });
    });
    return () => {
      current = false;
    };
  }, [token, attempt]);

  /** One change at a time; a dead link ends the page, anything else is shown. */
  const act = useCallback(
    async (label: string, step: () => Promise<{ ok: true } | { ok: false; code: string }>) => {
      setBusy(label);
      setError(null);
      const result = await step();
      setBusy(null);
      if (result.ok) return true;
      if (result.code === 'REGISTRATION_STATUS_NOT_FOUND') setLookup({ state: 'missing' });
      else setError(result.code);
      return false;
    },
    [],
  );

  if (link.state === 'reading') return <Loading />;
  if (!token) return <InvalidLink />;
  if (lookup.state === 'loading') return <Loading />;
  if (lookup.state === 'missing') {
    return (
      <Shell title={t('rs.title')}>
        <p>{t('rs.notfound')}</p>
      </Shell>
    );
  }
  if (lookup.state === 'failed') {
    return (
      <Shell title={t('rs.title')}>
        <ErrorNote code={lookup.code} />
        <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
          {t('common.retry')}
        </button>
      </Shell>
    );
  }

  const { view } = lookup;
  const refresh = () => setAttempt((n) => n + 1);
  const upload = (kind: Kind, file: File) =>
    act('upload', async () => {
      if (!TYPES.includes(file.type)) return { ok: false, code: 'FILE_TYPE_NOT_ALLOWED' };
      if (file.size > MAX_BYTES) return { ok: false, code: 'FILE_TOO_LARGE' };
      const declared = await post<UploadView>(
        'public/registrations/uploads',
        { token, kind, contentType: file.type, size: file.size },
        locale,
      );
      if (!declared.ok) return declared;
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
        return { ok: false, code: 'STORAGE_UNAVAILABLE' };
      }
      if (!put.ok) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
      return post(`public/registrations/documents/${declared.data.document.id}/finalize`, { token }, locale);
    }).then(refresh);
  const remove = (id: string) =>
    act(`remove:${id}`, () => post(`public/registrations/documents/${id}/remove`, { token }, locale)).then(refresh);
  const resubmit = () =>
    act('resubmit', () => post('public/registrations/resubmit', { token }, locale)).then((ok) => {
      if (ok) setSent(true);
      refresh();
    });

  const correcting = view.status === 'needs_correction';
  return (
    <Shell title={t('rs.title')}>
      <p className={`state state--${correcting ? 'off' : 'wait'}`} role="status">
        {t(correcting ? 'rs.needs_correction' : 'rs.pending')}
      </p>
      {correcting ? (
        <ul className="list">
          {view.correctionCodes.map((c) => (
            <li key={c}>{t(`rs.correction.${c}` as MessageKey)}</li>
          ))}
        </ul>
      ) : null}
      {sent && !correcting ? <p className="note">{t('rs.sent')}</p> : null}
      <dl className="facts">
        <dt>{t('clearance.compound')}</dt>
        <dd>{view.compoundName}</dd>
        <dt>{t('rs.unit')}</dt>
        <dd dir="ltr">{view.unitCode}</dd>
      </dl>

      <h2 className="card__subtitle">{t('rs.documents')}</h2>
      {view.documents.length === 0 ? <p className="muted">{t('rs.none')}</p> : null}
      <ul className="list">
        {view.documents.map((d) => (
          <li key={d.id}>
            {t(`rs.kind.${d.kind}`)}
            {d.ready ? null : <span className="muted"> · {t('rs.checking')}</span>}{' '}
            <button
              type="button"
              className="button button--quiet"
              disabled={busy !== null}
              onClick={() => void remove(d.id)}
            >
              {t('rs.remove')}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote code={error} />
      {view.documents.length < view.maxDocuments ? (
        <AddDocument busy={busy !== null} onAdd={(kind, file) => void upload(kind, file)} />
      ) : null}
      {correcting ? (
        <div className="actions">
          <button type="button" className="button" disabled={busy !== null} onClick={() => void resubmit()}>
            {t('rs.resubmit')}
          </button>
        </div>
      ) : null}
    </Shell>
  );
}

function AddDocument({ busy, onAdd }: { busy: boolean; onAdd: (kind: Kind, file: File) => void }) {
  const { t } = useLocale();
  const id = useId();
  const [kind, setKind] = useState<Kind>('ownership_proof');
  const [file, setFile] = useState<File | null>(null);
  return (
    <form
      className="confirm"
      onSubmit={(e) => {
        e.preventDefault();
        if (file) onAdd(kind, file);
        setFile(null);
        e.currentTarget.reset();
      }}
    >
      <div className="field">
        <label htmlFor={`${id}-kind`}>{t('rs.add')}</label>
        <select
          id={`${id}-kind`}
          className="input"
          value={kind}
          disabled={busy}
          onChange={(e) => setKind(e.target.value as Kind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`rs.kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <input
          className="input"
          type="file"
          accept={TYPES.join(',')}
          aria-label={t('rs.add')}
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <button type="submit" className="button" disabled={busy || !file}>
        {busy ? t('common.loading') : t('rs.add')}
      </button>
    </form>
  );
}
