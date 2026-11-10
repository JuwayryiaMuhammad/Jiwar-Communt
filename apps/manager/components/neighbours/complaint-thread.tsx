'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Badge, Button, Card, CardHeader, Textarea, type Tone } from '@jiwar/ui';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { keys, type ComplaintMessage } from '@/lib/queries';
import ar from '@/messages/ar/neighbours-complaint';
import en from '@/messages/en/neighbours-complaint';
import { Evidence } from './bits';
import { threadState, type Thread } from './logic';
import { useWho } from './who';
import { threadWhy } from './words';

const MAX_ATTACHMENTS = 5;

/** How each thread names itself, so nobody writes in the wrong one: its colour here, its words in the catalog (`<thread>.title`…). */
const TONE: Record<Thread, Tone> = { complainant: 'green', target: 'terracotta', internal: 'dark' };

// One literal path per thread: the three never share a call.
function read(thread: Thread, id: string, cursor: string | undefined) {
  const params = { path: { id }, query: { cursor, limit: 50 } };
  if (thread === 'complainant') return unwrap(api.GET('/api/v1/neighbours/complaints/{id}/messages', { params }));
  if (thread === 'target') return unwrap(api.GET('/api/v1/neighbours/complaints/{id}/unit-messages', { params }));
  return unwrap(api.GET('/api/v1/neighbours/complaints/{id}/notes', { params }));
}

function write(thread: Thread, id: string, idempotencyKey: string, body: { body: string; attachmentFileIds?: string[] }) {
  const params = { path: { id }, header: { 'Idempotency-Key': idempotencyKey } };
  if (thread === 'complainant') return unwrap(api.POST('/api/v1/neighbours/complaints/{id}/messages', { params, body }));
  if (thread === 'target') return unwrap(api.POST('/api/v1/neighbours/complaints/{id}/unit-messages', { params, body }));
  return unwrap(api.POST('/api/v1/neighbours/complaints/{id}/notes', { params, body }));
}

/**
 * One of a complaint's three threads, oldest first, with its own compose
 * box (ADR 0042). The complainant never reads the unit's thread and the
 * unit never reads the complainant's: each thread is its own card, with its
 * own draft and its own key, and says above the box who will read what is
 * sent. `to` names the reader; `lead` is shown above the messages (the
 * unit's notice).
 */
export function ComplaintThread({
  complaintId,
  thread,
  status,
  hasNotice,
  to,
  never,
  lead,
}: {
  complaintId: string;
  thread: Thread;
  status: string;
  hasNotice: boolean;
  /** Who reads what is sent here. */
  to: string;
  /** Who never does. */
  never: string;
  lead?: ReactNode;
}) {
  const t = useT(en, ar);
  const f = useFormat();
  const who = useWho();
  const tone = TONE[thread];
  const why = threadWhy(thread, status, hasNotice);
  const state = threadState(thread, status, hasNotice);
  // The unit's thread does not exist before its notice: nothing to read yet.
  const exists = thread !== 'target' || hasNotice;
  const [body, setBody] = useState('');
  const [fileIds, setFileIds] = useState<string[]>([]);
  // One key per draft: a retry replays the first post, and a new draft gets a new key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const list = useCursorList<ComplaintMessage>(keys.complaintPart(complaintId, `thread-${thread}`), (cursor) => read(thread, complaintId, cursor), {
    refetchInterval: 30_000,
    enabled: exists,
  });

  const send = useAction(
    () => write(thread, complaintId, idempotencyKey, { body: body.trim(), ...(fileIds.length ? { attachmentFileIds: fileIds } : {}) }),
    {
      // A message is activity: the complaint's page and the inbox too.
      invalidate: [keys.complaintsAll],
      onDone: () => {
        setBody('');
        setFileIds([]);
        setIdempotencyKey(crypto.randomUUID());
      },
    },
  );

  return (
    <Card flush>
      <CardHeader title={t(`${thread}.title`)} actions={<Badge tone={tone}>{t(`${thread}.badge`)}</Badge>}>
        <span className="t-secondary">{t('readBy', { to, never })}</span>
      </CardHeader>
      {lead}
      {exists ? (
        <QueryState query={list} rows={3}>
          {list.rows?.length ? (
            <div className="thread">
              {list.rows.map((m) => (
                <div
                  key={m.id}
                  className={`thread__msg${thread === 'internal' ? ' thread__msg--internal' : m.senderSide === 'staff' ? ' thread__msg--staff' : ''}`}
                >
                  <span className="thread__meta">
                    {who.person(m.sender)} · {m.senderSide === 'staff' ? t('management') : t(`${thread}.other`)} · {f.dateTime(m.createdAt)}
                  </span>
                  {m.erased ? <p className="thread__body t-secondary">{t('removed')}</p> : <p className="thread__body">{m.body}</p>}
                  <Evidence items={m.attachments} alt={t('evidence')} />
                </div>
              ))}
            </div>
          ) : (
            <p className="t-secondary" style={{ padding: 16 }}>
              {t(`${thread}.empty`)}
            </p>
          )}
          <LoadMore query={list} />
        </QueryState>
      ) : null}
      {state.write ? (
        <form
          className="form"
          style={{ padding: 16, borderTop: '1px solid var(--hairline-soft)' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) send.mutate();
          }}
        >
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Badge tone={tone}>{t(`${thread}.badge`)}</Badge>
            <strong>{t('to', { to })}</strong>
          </span>
          <Textarea
            aria-label={t(`${thread}.label`)}
            rows={3}
            maxLength={4000}
            placeholder={thread === 'internal' ? t('placeholder.internal') : t('placeholder.write', { to })}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <FileUpload
              purpose="complaint_evidence"
              label={fileIds.length ? t('attachAnother', { count: fileIds.length, max: MAX_ATTACHMENTS }) : t('attach')}
              disabled={fileIds.length >= MAX_ATTACHMENTS}
              onUploaded={(id) => setFileIds((ids) => [...ids, id])}
            />
            {fileIds.length ? (
              <Button type="button" size="sm" variant="text" icon={<X aria-hidden />} onClick={() => setFileIds([])}>
                {t('removeAttachments')}
              </Button>
            ) : null}
          </span>
          <span className="row" style={{ flexWrap: 'wrap' }}>
            <span className="t-secondary">{never}</span>
            <span className="spacer" />
            <Button type="submit" variant={thread === 'internal' ? 'dark' : 'primary'} loading={send.isPending} disabled={!body.trim()}>
              {t(`${thread}.send`)}
            </Button>
          </span>
          <ErrorAlert error={send.error} />
        </form>
      ) : (
        <div style={{ padding: 16, borderTop: exists ? '1px solid var(--hairline-soft)' : undefined }}>
          <Alert>{why ? t(`why.${why}`) : null}</Alert>
        </div>
      )}
    </Card>
  );
}
