'use client';

import { formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, Dialog, Field, Input, StatusBadge, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys, type TicketDetail, type TicketQuote } from '@/lib/queries';

/** Statuses a quote may be proposed in (the API's QUOTABLE, ADR 0058). */
const QUOTABLE = ['new', 'assigned', 'en_route'];
/** EGP, as the API takes it (QUOTE_AMOUNT): above zero, below ten million. */
const AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,7}(\.\d{1,2})?$/;

/**
 * A unit's ticket's quotes (ADR 0058): proposed by the dispatch before the
 * work starts, one waiting at a time; the reporter or the unit's primary
 * approves or declines it in the app; work does not start while one waits
 * or after a decline. A waiting quote may be withdrawn.
 */
export function TicketQuotes({ ticket }: { ticket: TicketDetail }) {
  const toast = useToast();
  const { can } = usePermissions();
  const mayDispatch = can('tickets.dispatch');
  const [proposing, setProposing] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const key = keys.ticketPart(ticket.id, 'quotes');
  const quotes = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/tickets/{id}/quotes', { params: { path: { id: ticket.id } } })),
    enabled: mayDispatch && !!ticket.unit,
  });
  const propose = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/quotes', {
          params: { path: { id: ticket.id } },
          body: { amount, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.ticketsAll],
      onDone: () => {
        toast.show('Quote proposed. The resident is asked to approve it.');
        setProposing(false);
        setAmount('');
        setNote('');
      },
    },
  );
  const withdraw = useAction(
    (q: TicketQuote) =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/quotes/{quoteId}/withdraw', {
          params: { path: { id: ticket.id, quoteId: q.id } },
        }),
      ),
    { invalidate: [keys.ticketsAll], onDone: () => toast.show('Quote withdrawn.') },
  );
  // A common-area ticket takes no quote; nor does a reader without dispatch.
  if (!ticket.unit || !mayDispatch) return null;
  const rows = quotes.data?.data ?? [];
  const waiting = rows.some((q) => q.status === 'proposed');
  const mayPropose = QUOTABLE.includes(ticket.status) && !waiting;
  return (
    <Card flush>
      <CardHeader
        title="Quotes"
        actions={
          mayPropose ? (
            <Button size="sm" onClick={() => setProposing(true)}>
              Propose a quote
            </Button>
          ) : null
        }
      />
      <QueryState query={quotes}>
        {rows.length ? (
          <ul className="list">
            {rows.map((q) => (
              <li key={q.id} className="list__item" style={{ alignItems: 'flex-start' }}>
                <span className="list__text">
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="t-num">{q.amount} EGP</span>
                    <StatusBadge status={q.status} />
                    {q.declineReason ? <span className="t-secondary">{humanize(q.declineReason)}</span> : null}
                  </span>
                  {q.note ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{q.note}</p> : null}
                  <span className="list__meta">
                    Proposed {formatDateTime(q.proposedAt)}
                    {q.decidedAt ? ` · decided ${formatDateTime(q.decidedAt)}` : ''}
                    {q.withdrawnAt ? ` · withdrawn ${formatDateTime(q.withdrawnAt)}` : ''}
                  </span>
                </span>
                {q.status === 'proposed' ? (
                  <Button size="sm" loading={withdraw.isPending} onClick={() => withdraw.mutate(q)}>
                    Withdraw
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-secondary" style={{ margin: 16 }}>
            No quote. Work that the unit pays for is quoted before it starts.
          </p>
        )}
        <ErrorAlert error={withdraw.error} />
      </QueryState>
      {proposing ? (
        <Dialog
          open
          onClose={() => setProposing(false)}
          title="Propose a quote"
          description="The reporter or the unit’s primary approves or declines it; the work does not start before."
          onSubmit={() => propose.mutate()}
          footer={
            <>
              <Button onClick={() => setProposing(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={propose.isPending} disabled={!AMOUNT.test(amount)}>
                Propose
              </Button>
            </>
          }
        >
          <div className="form">
            <Field label="Amount (EGP)">
              {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />}
            </Field>
            <Field label="What it includes" hint="The residents read it.">
              {(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <ErrorAlert error={propose.error} />
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}
