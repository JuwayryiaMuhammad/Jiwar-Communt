'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, CardHeader, Textarea, type Tone } from '@jiwar/ui';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { keys, type ComplaintMessage } from '@/lib/queries';
import { Evidence, personName } from './bits';
import { threadState, type Thread } from './logic';

const MAX_ATTACHMENTS = 5;

/** How each thread names itself, so nobody writes in the wrong one. */
const COPY: Record<Thread, { title: string; badge: string; tone: Tone; other: string; label: string; send: string; empty: string }> = {
  complainant: {
    title: 'With the complainant',
    badge: 'Complainant only',
    tone: 'green',
    other: 'resident (complainant)',
    label: 'Message to the complainant',
    send: 'Send to the complainant',
    empty: 'Nothing was written to the complainant yet.',
  },
  target: {
    title: 'With the unit complained about',
    badge: 'Unit only',
    tone: 'terracotta',
    other: 'resident (the unit)',
    label: 'Message to the unit complained about',
    send: 'Send to the unit',
    empty: 'The unit has its notice and has not answered.',
  },
  internal: {
    title: 'Internal notes',
    badge: 'Staff only',
    tone: 'dark',
    other: 'resident',
    label: 'Internal note',
    send: 'Add note',
    empty: 'No note yet.',
  },
};

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
  const copy = COPY[thread];
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
      <CardHeader title={copy.title} actions={<Badge tone={copy.tone}>{copy.badge}</Badge>}>
        <span className="t-secondary">
          Read by {to}. {never}
        </span>
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
                    {personName(m.sender)} · {m.senderSide === 'staff' ? 'management' : copy.other} · {formatDateTime(m.createdAt)}
                  </span>
                  {m.erased ? <p className="thread__body t-secondary">Message removed</p> : <p className="thread__body">{m.body}</p>}
                  <Evidence items={m.attachments} alt="Evidence" />
                </div>
              ))}
            </div>
          ) : (
            <p className="t-secondary" style={{ padding: 16 }}>
              {copy.empty}
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
            <Badge tone={copy.tone}>{copy.badge}</Badge>
            <strong>To: {to}</strong>
          </span>
          <Textarea
            aria-label={copy.label}
            rows={3}
            maxLength={4000}
            placeholder={thread === 'internal' ? 'A note for staff only…' : `Write to ${to}…`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <FileUpload
              purpose="complaint_evidence"
              label={fileIds.length ? `Attach another (${fileIds.length} of ${MAX_ATTACHMENTS})` : 'Attach a file'}
              disabled={fileIds.length >= MAX_ATTACHMENTS}
              onUploaded={(id) => setFileIds((ids) => [...ids, id])}
            />
            {fileIds.length ? (
              <Button type="button" size="sm" variant="text" icon={<X aria-hidden />} onClick={() => setFileIds([])}>
                Remove attachments
              </Button>
            ) : null}
          </span>
          <span className="row" style={{ flexWrap: 'wrap' }}>
            <span className="t-secondary">{never}</span>
            <span className="spacer" />
            <Button type="submit" variant={thread === 'internal' ? 'dark' : 'primary'} loading={send.isPending} disabled={!body.trim()}>
              {copy.send}
            </Button>
          </span>
          <ErrorAlert error={send.error} />
        </form>
      ) : (
        <div style={{ padding: 16, borderTop: exists ? '1px solid var(--hairline-soft)' : undefined }}>
          <Alert>{state.why}</Alert>
        </div>
      )}
    </Card>
  );
}
