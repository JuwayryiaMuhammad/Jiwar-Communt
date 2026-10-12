'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, CardHeader, Checkbox, Textarea } from '@jiwar/ui';
import { FileText, X } from 'lucide-react';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { keys, type RequestMessage } from '@/lib/queries';
import { personName } from './bits';
import { actionsFor } from './logic';

const MAX_ATTACHMENTS = 5;

function Attachments({ message }: { message: RequestMessage }) {
  if (!message.attachments.length) return null;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      {message.attachments.map((a) =>
        a.url === null ? (
          <span key={a.id} className="t-secondary">
            File no longer available
          </span>
        ) : a.contentType.startsWith('image/') ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
            {/* A presigned URL: no referrer, so it is not handed on. */}
            <img src={a.url} alt="Attachment" loading="lazy" referrerPolicy="no-referrer" style={{ maxHeight: 96, borderRadius: 6 }} />
          </a>
        ) : (
          <a key={a.id} className="row" style={{ gap: 4 }} href={a.url} target="_blank" rel="noreferrer">
            <FileText size={16} aria-hidden />
            Document (PDF)
          </a>
        ),
      )}
    </div>
  );
}

/**
 * The request's conversation, oldest first. Staff also read and write
 * internal notes, set apart from the rest: the resident never sees them. A
 * reply may be sent as the official reply, which answers the request; that
 * choice is made when sending and cannot be changed afterwards.
 */
export function RequestThread({ requestId, status }: { requestId: string; status: string }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [fileIds, setFileIds] = useState<string[]>([]);
  // One key per draft: a retry replays the first post, and a new draft gets a new key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const key = keys.managementRequestPart(requestId, 'messages');
  const may = actionsFor(status);
  // A closed request takes notes only.
  const note = internal || !may.reply;

  const list = useCursorList<RequestMessage>(
    key,
    (cursor) =>
      unwrap(
        api.GET('/api/v1/management/requests/{id}/messages', {
          params: { path: { id: requestId }, query: { cursor, limit: 50 } },
        }),
      ),
    { refetchInterval: 30_000 },
  );

  const send = useAction(
    (official: boolean) =>
      unwrap(
        api.POST('/api/v1/management/requests/{id}/messages', {
          params: { path: { id: requestId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            body: body.trim(),
            internal: note,
            official: !note && official,
            ...(fileIds.length ? { attachmentFileIds: fileIds } : {}),
          },
        }),
      ),
    {
      // The reply may have moved the request: its page and the inbox too.
      invalidate: [keys.managementAll],
      onDone: () => {
        setBody('');
        setFileIds([]);
        setInternal(false);
        setIdempotencyKey(crypto.randomUUID());
      },
    },
  );

  return (
    <Card flush>
      <CardHeader title="Conversation" />
      <QueryState query={list} rows={3}>
        {list.rows?.length ? (
          <div className="thread">
            {list.rows.map((m) => (
              <div
                key={m.id}
                className={`thread__msg${m.internal ? ' thread__msg--internal' : m.senderSide === 'staff' ? ' thread__msg--staff' : ''}`}
              >
                <span className="thread__meta">
                  {m.internal ? <Badge tone="dark">Internal note</Badge> : null}
                  {m.official ? <Badge tone="green">Official reply</Badge> : null} {personName(m.sender)} ·{' '}
                  {m.senderSide === 'staff' ? 'management' : 'resident'} · {formatDateTime(m.createdAt)}
                </span>
                {m.erased ? <p className="thread__body t-secondary">Message removed</p> : <p className="thread__body">{m.body}</p>}
                <Attachments message={m} />
              </div>
            ))}
          </div>
        ) : (
          <p className="t-secondary" style={{ padding: 16 }}>
            No message yet.
          </p>
        )}
        <LoadMore query={list} />
      </QueryState>
      <form
        className="form"
        style={{ padding: 16, borderTop: '1px solid var(--hairline-soft)' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) send.mutate(false);
        }}
      >
        <Textarea
          aria-label={note ? 'Internal note' : 'Reply'}
          rows={3}
          maxLength={4000}
          placeholder={note ? 'A note for staff only…' : 'A reply to the resident…'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <FileUpload
            purpose="request_attachment"
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
          {may.reply ? (
            <Checkbox
              label="Internal note: staff only, never shown to the resident"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
            />
          ) : (
            <span className="t-secondary">The request is closed: only an internal note can be added.</span>
          )}
          <span className="spacer" />
          {note ? (
            <Button type="submit" variant="dark" loading={send.isPending} disabled={!body.trim()}>
              Add note
            </Button>
          ) : (
            <>
              <Button type="submit" loading={send.isPending} disabled={!body.trim()}>
                Send
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={send.isPending}
                disabled={!body.trim()}
                title="Answers the request. The resident is told, and it closes by itself if they do not reply."
                onClick={() => send.mutate(true)}
              >
                Send as official reply
              </Button>
            </>
          )}
        </span>
        <ErrorAlert error={send.error} />
      </form>
    </Card>
  );
}
