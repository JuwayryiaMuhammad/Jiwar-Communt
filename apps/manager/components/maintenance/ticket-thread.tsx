'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardHeader, Checkbox, Textarea } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type TicketMessage } from '@/lib/queries';
import { personName } from './sla';

/** Messages may be posted until the ticket is closed or cancelled. */
const WRITABLE = ['new', 'assigned', 'en_route', 'in_progress', 'on_hold', 'completed'];

/**
 * The ticket's thread, oldest first. Dispatch also reads and writes internal
 * notes, which the resident never sees.
 */
export function TicketThread({ ticketId, status }: { ticketId: string; status: string }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  // One key per draft: a retry replays the first post, and a new draft gets a new key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const key = keys.ticketPart(ticketId, 'messages');
  const list = useCursorList<TicketMessage>(
    key,
    (cursor) =>
      unwrap(
        api.GET('/api/v1/maintenance/tickets/{id}/messages', {
          params: { path: { id: ticketId }, query: { cursor, limit: 50 } },
        }),
      ),
    { refetchInterval: 30_000 },
  );

  const send = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/messages', {
          params: { path: { id: ticketId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { body: body.trim(), internal },
        }),
      ),
    {
      invalidate: [key],
      onDone: () => {
        setBody('');
        setIdempotencyKey(crypto.randomUUID());
      },
    },
  );

  return (
    <Card flush>
      <CardHeader title="Messages" />
      <QueryState query={list} rows={3}>
        {list.rows?.length ? (
          <div className="thread">
            {list.rows.map((m) => (
              <div
                key={m.id}
                className={`thread__msg${m.internal ? ' thread__msg--internal' : m.senderKind === 'resident' ? '' : ' thread__msg--staff'}`}
              >
                <span className="thread__meta">
                  {personName(m.sender)} · {m.senderKind}
                  {m.internal ? ' · internal note' : ''} · {formatDateTime(m.createdAt)}
                </span>
                {m.deleted ? (
                  <p className="thread__body t-secondary">Message removed</p>
                ) : (
                  <p className="thread__body">{m.body}</p>
                )}
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
      {WRITABLE.includes(status) ? (
        <form
          className="form"
          style={{ padding: 16, borderTop: '1px solid var(--hairline-soft)' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) send.mutate();
          }}
        >
          <Textarea
            aria-label="Message"
            rows={3}
            maxLength={2000}
            placeholder={internal ? 'A note for staff only…' : 'A message to the resident and the technician…'}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="row">
            <Checkbox
              label="Internal note: staff only, never shown to the resident"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
            />
            <span className="spacer" />
            <Button type="submit" variant="primary" loading={send.isPending} disabled={!body.trim()}>
              {internal ? 'Add note' : 'Send'}
            </Button>
          </span>
          <ErrorAlert error={send.error} />
        </form>
      ) : null}
    </Card>
  );
}
