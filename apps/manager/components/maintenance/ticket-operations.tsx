'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  Input,
  ReasonCodeDialog,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type QuoteSuggestion, type TicketCostEntry, type TicketDetail } from '@/lib/queries';
import ar from '@/messages/ar/maint-operations';
import en from '@/messages/en/maint-operations';

/** What the technician did at the last completion (ADR 0065). */
export function TicketCompletion({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  if (!ticket.completion) return null;
  return (
    <Card flush>
      <CardHeader title={t('whatWasDone')} />
      <CardBody>
        <p>
          <strong>{label(ticket.completion.actionCode)}</strong> · {fmt.dateTime(ticket.completion.completedAt)}
        </p>
        {ticket.completion.note ? <p className="text-muted">{ticket.completion.note}</p> : null}
      </CardBody>
    </Card>
  );
}

const RECORDED = ['labour', 'contractor', 'other'] as const;

/** A ticket's costs (ADR 0065): dispatch records labour, contractors and others; parts come from the store. */
export function TicketCosts({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
        toast.show(t('recorded'));
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
        toast.show(t('voided'));
        setVoiding(null);
      },
    },
  );
  const totals = costs.data?.totals;
  const sum = (x: string) => fmt.number(x, { minimumFractionDigits: 2 });
  return (
    <Card flush>
      <CardHeader
        title={t('costs')}
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            {t('recordCost')}
          </Button>
        }
      >
        {totals ? (
          <span className="text-muted">
            {t('totals', {
              total: fmt.money(totals.total),
              labour: sum(totals.labour),
              contractor: sum(totals.contractor),
              parts: sum(totals.parts),
              other: sum(totals.other),
            })}
          </span>
        ) : null}
      </CardHeader>
      <QueryState query={costs}>
        <DataTable<TicketCostEntry>
          rows={costs.data?.data ?? []}
          rowKey={(e) => e.id}
          empty={t('noCosts')}
          columns={[
            { key: 'k', header: t('col.kind'), cell: (e) => label(e.kind) },
            { key: 'd', header: t('col.what'), cell: (e) => e.description ?? t('partFromStore') },
            { key: 'q', header: t('col.quantity'), cell: (e) => fmt.number(e.quantity) },
            { key: 'a', header: t('col.amount'), cell: (e) => (e.voidedAt ? <s>{fmt.money(e.amount)}</s> : fmt.money(e.amount)) },
            { key: 'w', header: t('col.when'), cell: (e) => fmt.dateTime(e.enteredAt) },
            {
              key: 'x',
              header: <span className="visually-hidden">{c('actions')}</span>,
              className: 'table__actions',
              cell: (e) =>
                e.kind !== 'part' && !e.voidedAt ? (
                  <Button size="sm" onClick={() => setVoiding(e)}>
                    {t('void')}
                  </Button>
                ) : e.voidReason ? (
                  label(e.voidReason)
                ) : null,
            },
          ]}
        />
      </QueryState>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t('recordCost')}
        description={t('costDescription')}
        onSubmit={() => record.mutate()}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={record.isPending} disabled={!description.trim() || !unitAmount}>
              {t('record')}
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={record.error} />
          <Field label={t('kind')} error={fieldError(record.error, 'kind')}>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {RECORDED.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('whatItWas')} error={fieldError(record.error, 'description')}>
            {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <div className="form__row">
            <Field label={t('quantity')} hint={t('quantityHint')} error={fieldError(record.error, 'quantity')}>
              {(p) => <Input {...p} value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
            </Field>
            <Field label={t('unitAmount')} error={fieldError(record.error, 'unitAmount')}>
              {(p) => <Input {...p} value={unitAmount} onChange={(e) => setUnitAmount(e.target.value)} />}
            </Field>
          </div>
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title={t('voidTitle')}
        codes={REASON_CODES.ticketCostVoid}
        confirmLabel={t('void')}
        danger
        pending={voidEntry.isPending}
        error={<ErrorAlert error={voidEntry.error} />}
        onConfirm={(code) => voiding && voidEntry.mutate({ id: voiding.id, reasonCode: code })}
      />
    </Card>
  );
}

/** A ticket's parts (ADR 0065): what the technician asked the store for and what it got. */
export function TicketParts({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const parts = useQuery({ queryKey: keys.ticketParts(ticket.id), queryFn: () => fetchers.ticketParts(ticket.id) });
  if (parts.data && !parts.data.requests.length && !parts.data.parts.length) return null;
  return (
    <Card flush>
      <CardHeader title={t('parts')} />
      <QueryState query={parts}>
        <DataTable
          rows={parts.data?.requests ?? []}
          rowKey={(r) => r.id}
          empty={t('noPartAsked')}
          columns={[
            { key: 'i', header: t('col.item'), cell: (r) => parts.data?.parts.find((p) => p.itemId === r.itemId)?.sku ?? '—' },
            { key: 'q', header: t('col.quantity'), cell: (r) => fmt.number(r.quantity) },
            {
              key: 's',
              header: t('col.status'),
              cell: (r) => (r.reasonCode ? t('withReason', { status: label(r.status), reason: label(r.reasonCode) }) : label(r.status)),
            },
            { key: 'w', header: t('col.asked'), cell: (r) => fmt.dateTime(r.requestedAt) },
          ]}
        />
        {parts.data?.parts.length ? (
          <CardBody>
            {parts.data.parts.map((p) => (
              <p key={p.itemId}>{t('partLine', { sku: p.sku, issued: fmt.number(p.issued), returned: fmt.number(p.returned) })}</p>
            ))}
          </CardBody>
        ) : null}
      </QueryState>
    </Card>
  );
}

/** The technician's suggested quotes (ADR 0065): dispatch sends one as the quote, or dismisses it. */
export function TicketQuoteSuggestions({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
        toast.show(t('sentToResidents'));
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
        toast.show(t('dismissed'));
        setDismissing(null);
      },
    },
  );
  const rows = list.data?.data ?? [];
  if (!rows.length) return null;
  return (
    <Card flush>
      <CardHeader title={t('suggestedQuotes')} />
      <DataTable<QuoteSuggestion>
        rows={rows}
        rowKey={(s) => s.id}
        empty={c('none')}
        columns={[
          { key: 'a', header: t('col.amount'), cell: (s) => fmt.money(s.amount) },
          { key: 'n', header: t('col.note'), cell: (s) => s.note ?? '—' },
          {
            key: 's',
            header: t('col.status'),
            cell: (s) =>
              s.dismissReason ? t('withReason', { status: label(s.status), reason: label(s.dismissReason) }) : label(s.status),
          },
          { key: 'w', header: t('col.when'), cell: (s) => fmt.dateTime(s.suggestedAt) },
          {
            key: 'x',
            header: <span className="visually-hidden">{c('actions')}</span>,
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
                    {t('send')}
                  </Button>
                  <Button size="sm" onClick={() => setDismissing(s)}>
                    {t('dismiss')}
                  </Button>
                </span>
              ) : null,
          },
        ]}
      />
      <Dialog
        open={sending !== null}
        onClose={() => setSending(null)}
        title={t('sendTitle')}
        description={t('sendDescription')}
        onSubmit={() => send.mutate()}
        footer={
          <>
            <Button onClick={() => setSending(null)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={send.isPending} disabled={!amount}>
              {t('send')}
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={send.error} />
          <Field label={t('amount')} error={fieldError(send.error, 'amount')}>
            {(p) => <Input {...p} value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={dismissing !== null}
        onClose={() => setDismissing(null)}
        title={t('dismissTitle')}
        codes={REASON_CODES.quoteSuggestionDismiss}
        confirmLabel={t('dismiss')}
        pending={dismiss.isPending}
        error={<ErrorAlert error={dismiss.error} />}
        onConfirm={(code) => dismissing && dismiss.mutate({ id: dismissing.id, reasonCode: code })}
      />
    </Card>
  );
}
