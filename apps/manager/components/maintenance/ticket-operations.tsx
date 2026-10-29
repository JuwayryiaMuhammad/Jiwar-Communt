'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, Field, Input, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type QuoteSuggestion, type TicketCostEntry, type TicketDetail } from '@/lib/queries';

/** What the technician did at the last completion (ADR 0065). */
export function TicketCompletion({ ticket }: { ticket: TicketDetail }) {
  if (!ticket.completion) return null;
  return (
    <Card flush>
      <CardHeader title="What was done" />
      <CardBody>
        <p>
          <strong>{humanize(ticket.completion.actionCode)}</strong> · {formatDateTime(ticket.completion.completedAt)}
        </p>
        {ticket.completion.note ? <p className="text-muted">{ticket.completion.note}</p> : null}
      </CardBody>
    </Card>
  );
}

const RECORDED = ['labour', 'contractor', 'other'] as const;

/** A ticket's costs (ADR 0065): dispatch records labour, contractors and others; parts come from the store. */
export function TicketCosts({ ticket }: { ticket: TicketDetail }) {
  const toast = useToast();
  const costs = useQuery({ queryKey: keys.ticketCosts(ticket.id), queryFn: () => fetchers.ticketCosts(ticket.id) });
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<TicketCostEntry | null>(null);
  const [kind, setKind] = useState<(typeof RECORDED)[number]>('labour');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitAmount, setUnitAmount] = useState('');
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/costs', {
          params: { path: { id: ticket.id } },
          body: { kind, description: description.trim(), quantity, unitAmount },
        }),
      ),
    {
      invalidate: [keys.ticketCosts(ticket.id)],
      onDone: () => {
        toast.show('Recorded.');
        setAdding(false);
        setDescription('');
        setUnitAmount('');
      },
    },
  );
  const voidEntry = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/ticket-costs/{id}/void', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.ticketCosts(ticket.id)],
      onDone: () => {
        toast.show('Voided.');
        setVoiding(null);
      },
    },
  );
  const t = costs.data?.totals;
  return (
    <Card flush>
      <CardHeader
        title="Costs"
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            Record a cost
          </Button>
        }
      >
        {t ? (
          <span className="text-muted">
            {t.total} EGP · labour {t.labour} · contractors {t.contractor} · parts {t.parts} · other {t.other}
          </span>
        ) : null}
      </CardHeader>
      <QueryState query={costs}>
        <DataTable<TicketCostEntry>
          rows={costs.data?.data ?? []}
          rowKey={(e) => e.id}
          empty="No costs yet"
          columns={[
            { key: 'k', header: 'Kind', cell: (e) => humanize(e.kind) },
            { key: 'd', header: 'What', cell: (e) => e.description ?? 'Part from the store' },
            { key: 'q', header: 'Quantity', cell: (e) => e.quantity },
            { key: 'a', header: 'Amount', cell: (e) => (e.voidedAt ? <s>{e.amount} EGP</s> : `${e.amount} EGP`) },
            { key: 'w', header: 'When', cell: (e) => formatDateTime(e.enteredAt) },
            {
              key: 'x',
              header: <span className="visually-hidden">Actions</span>,
              className: 'table__actions',
              cell: (e) =>
                e.kind !== 'part' && !e.voidedAt ? (
                  <Button size="sm" onClick={() => setVoiding(e)}>
                    Void
                  </Button>
                ) : e.voidReason ? (
                  humanize(e.voidReason)
                ) : null,
            },
          ]}
        />
      </QueryState>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Record a cost"
        description="Parts are not recorded here: the store writes them as it issues."
        onSubmit={() => record.mutate()}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={record.isPending} disabled={!description.trim() || !unitAmount}>
              Record
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={record.error} />
          <Field label="Kind" error={fieldError(record.error, 'kind')}>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {RECORDED.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="What it was" error={fieldError(record.error, 'description')}>
            {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <div className="form__row">
            <Field label="Quantity" hint="Hours, visits, items." error={fieldError(record.error, 'quantity')}>
              {(p) => <Input {...p} value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
            </Field>
            <Field label="Unit amount (EGP)" error={fieldError(record.error, 'unitAmount')}>
              {(p) => <Input {...p} value={unitAmount} onChange={(e) => setUnitAmount(e.target.value)} />}
            </Field>
          </div>
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title="Void the entry"
        codes={REASON_CODES.ticketCostVoid}
        confirmLabel="Void"
        danger
        pending={voidEntry.isPending}
        error={<ErrorAlert error={voidEntry.error} />}
        onConfirm={(c) => voiding && voidEntry.mutate({ id: voiding.id, reasonCode: c })}
      />
    </Card>
  );
}

/** A ticket's parts (ADR 0065): what the technician asked the store for and what it got. */
export function TicketParts({ ticket }: { ticket: TicketDetail }) {
  const parts = useQuery({ queryKey: keys.ticketParts(ticket.id), queryFn: () => fetchers.ticketParts(ticket.id) });
  if (parts.data && !parts.data.requests.length && !parts.data.parts.length) return null;
  return (
    <Card flush>
      <CardHeader title="Parts" />
      <QueryState query={parts}>
        <DataTable
          rows={parts.data?.requests ?? []}
          rowKey={(r) => r.id}
          empty="No part asked for"
          columns={[
            { key: 'i', header: 'Item', cell: (r) => parts.data?.parts.find((p) => p.itemId === r.itemId)?.sku ?? '—' },
            { key: 'q', header: 'Quantity', cell: (r) => r.quantity },
            { key: 's', header: 'Status', cell: (r) => humanize(r.status) + (r.reasonCode ? ` (${humanize(r.reasonCode).toLowerCase()})` : '') },
            { key: 'w', header: 'Asked', cell: (r) => formatDateTime(r.requestedAt) },
          ]}
        />
        {parts.data?.parts.length ? (
          <CardBody>
            {parts.data.parts.map((p) => (
              <p key={p.itemId}>
                {p.sku}: issued {p.issued}, returned {p.returned}
              </p>
            ))}
          </CardBody>
        ) : null}
      </QueryState>
    </Card>
  );
}

/** The technician's suggested quotes (ADR 0065): dispatch sends one as the quote, or dismisses it. */
export function TicketQuoteSuggestions({ ticket }: { ticket: TicketDetail }) {
  const toast = useToast();
  const { can } = usePermissions();
  const list = useQuery({
    queryKey: keys.quoteSuggestions(ticket.id),
    queryFn: () => fetchers.quoteSuggestions(ticket.id),
    enabled: can('tickets.dispatch'),
  });
  const [sending, setSending] = useState<QuoteSuggestion | null>(null);
  const [dismissing, setDismissing] = useState<QuoteSuggestion | null>(null);
  const [amount, setAmount] = useState('');
  const refresh = [keys.quoteSuggestions(ticket.id), keys.ticket(ticket.id)];
  const send = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/quote-suggestions/{id}/send', {
          params: { path: { id: sending!.id } },
          body: amount && amount !== sending!.amount ? { amount } : {},
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Sent to the residents.');
        setSending(null);
      },
    },
  );
  const dismiss = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/quote-suggestions/{id}/dismiss', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Dismissed.');
        setDismissing(null);
      },
    },
  );
  const rows = list.data?.data ?? [];
  if (!rows.length) return null;
  return (
    <Card flush>
      <CardHeader title="Suggested quotes" />
      <DataTable<QuoteSuggestion>
        rows={rows}
        rowKey={(s) => s.id}
        empty="None"
        columns={[
          { key: 'a', header: 'Amount', cell: (s) => `${s.amount} EGP` },
          { key: 'n', header: 'Note', cell: (s) => s.note ?? '—' },
          { key: 's', header: 'Status', cell: (s) => humanize(s.status) + (s.dismissReason ? ` (${humanize(s.dismissReason).toLowerCase()})` : '') },
          { key: 'w', header: 'When', cell: (s) => formatDateTime(s.suggestedAt) },
          {
            key: 'x',
            header: <span className="visually-hidden">Actions</span>,
            className: 'table__actions',
            cell: (s) =>
              s.status === 'pending' ? (
                <span className="row" style={{ gap: 6 }}>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setAmount(s.amount);
                      setSending(s);
                    }}
                  >
                    Send
                  </Button>
                  <Button size="sm" onClick={() => setDismissing(s)}>
                    Dismiss
                  </Button>
                </span>
              ) : null,
          },
        ]}
      />
      <Dialog
        open={sending !== null}
        onClose={() => setSending(null)}
        title="Send as the quote"
        description="The residents are asked to approve it before the work starts."
        onSubmit={() => send.mutate()}
        footer={
          <>
            <Button onClick={() => setSending(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={send.isPending} disabled={!amount}>
              Send
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={send.error} />
          <Field label="Amount (EGP)" error={fieldError(send.error, 'amount')}>
            {(p) => <Input {...p} value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={dismissing !== null}
        onClose={() => setDismissing(null)}
        title="Dismiss the suggestion"
        codes={REASON_CODES.quoteSuggestionDismiss}
        confirmLabel="Dismiss"
        pending={dismiss.isPending}
        error={<ErrorAlert error={dismiss.error} />}
        onConfirm={(c) => dismissing && dismiss.mutate({ id: dismissing.id, reasonCode: c })}
      />
    </Card>
  );
}
