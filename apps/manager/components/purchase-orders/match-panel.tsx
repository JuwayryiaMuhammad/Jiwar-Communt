'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ReasonCodeDialog, Textarea, useLabel, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys, type InvoiceMatch, type VendorInvoice } from '@/lib/queries';
import ar from '@/messages/ar/po-match';
import en from '@/messages/en/po-match';

type MatchLine = InvoiceMatch['lines'][number];
type Issue = InvoiceMatch['issues'][number];

const TONE = { matched: 'green', blocked: 'error', overridden: 'terracotta', none: 'beige' } as const;

/** One issue in words. */
export function IssueText({ issue }: { issue: Issue }) {
  const t = useT(en, ar);
  const f = useFormat();
  return (
    <>
      {t(`issue.${issue.kind}`, {
        position: f.number(issue.position),
        quantity: f.number(issue.quantity, { maximumFractionDigits: 3 }),
        amount: f.money(issue.amount),
      })}
    </>
  );
}

/**
 * The three-way match of a vendor’s invoice (ADR 0094): its lines beside the
 * order’s, what was accepted and billed before, the price variance and the
 * tolerances; a blocked one is resolved by a receipt or a corrected invoice,
 * or let through with a reason by someone who did not record it.
 */
export function MatchPanel({ invoice, match }: { invoice: VendorInvoice; match: InvoiceMatch }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { can } = usePermissions();
  const [overriding, setOverriding] = useState(false);
  const [note, setNote] = useState('');
  const override = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/finance/vendor-invoices/{id}/match/override', {
          params: { path: { id: invoice.id } },
          body: { reasonCode, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.payablesAll],
      onDone: () => {
        toast.show(t('overridden', { number: invoice.number }));
        setOverriding(false);
        setNote('');
      },
    },
  );
  const order = match.orderReference ?? '';
  const waiting = invoice.status === 'received';
  const blocked = match.status === 'blocked';
  const canOverride = blocked && waiting && can('finance.match_override');
  const canReceive = can('purchase_orders.receive') || can('purchase_orders.raise');
  const tol = match.tolerance;
  return (
    <Card>
      <SectionHeader
        title={t('title')}
        description={t('description', { order })}
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Badge tone={TONE[match.status]}>{t(`status.${match.status}`)}</Badge>
            {match.purchaseOrderId ? (
              <Link className="ltr" href={`/purchase-orders/${match.purchaseOrderId}`}>
                {t('openOrder', { order })}
              </Link>
            ) : null}
          </span>
        }
      />
      <div className="stack">
        {match.status === 'matched' ? <p className="t-secondary">{t('matchedBody')}</p> : null}
        {blocked ? <p>{t('blockedBody')}</p> : null}
        {match.issues.length ? (
          <div className="stack stack--sm">
            <strong>{t('issuesTitle')}</strong>
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {match.issues.map((x) => (
                <li key={`${x.kind}-${x.position}`}>
                  <IssueText issue={x} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <DataTable<MatchLine>
          rows={match.lines}
          rowKey={(l) => String(l.position)}
          columns={[
            { key: 'd', header: t('col.line'), cell: (l) => `${l.position}. ${l.description}` },
            {
              key: 'o',
              header: t('col.ordered'),
              cell: (l) => (l.orderLineId ? f.number(l.orderedQuantity, { maximumFractionDigits: 3 }) : t('extraLine')),
            },
            { key: 'a', header: t('col.accepted'), cell: (l) => f.number(l.acceptedQuantity, { maximumFractionDigits: 3 }) },
            { key: 'p', header: t('col.billedBefore'), cell: (l) => f.number(l.otherInvoicedQuantity, { maximumFractionDigits: 3 }) },
            {
              key: 'q',
              header: t('col.billed'),
              cell: (l) => (l.invoiceQuantity === null ? f.money(l.amount) : f.number(l.invoiceQuantity, { maximumFractionDigits: 3 })),
            },
            { key: 'op', header: t('col.orderPrice'), cell: (l) => (l.orderUnitPrice === null ? '—' : f.money(l.orderUnitPrice)) },
            { key: 'ip', header: t('col.invoicePrice'), cell: (l) => (l.invoiceUnitPrice === null ? '—' : f.money(l.invoiceUnitPrice)) },
            { key: 'v', header: t('col.variance'), cell: (l) => (l.orderLineId ? f.money(l.priceVariance) : '—') },
            {
              key: 'i',
              header: t('col.issues'),
              cell: (l) => (l.issues.length ? <span className="stack stack--sm">{l.issues.map((k) => <Badge key={k} tone="error">{label(k)}</Badge>)}</span> : '—'),
            },
          ]}
        />
        <p className="t-secondary">{t('priceVariance', { amount: f.money(match.priceVariance) })}</p>
        <p className="t-secondary">
          {t('tolerance', {
            price: f.percent(Number(tol.pricePct) / 100, 2),
            quantity: f.percent(Number(tol.quantityPct) / 100, 2),
            amount: f.money(tol.amount),
          })}
        </p>
        {match.override ? (
          <div className="stack stack--sm">
            <p>{t('overriddenOn', { when: f.dateTime(match.override.overriddenAt), reason: label(match.override.reasonCode) })}</p>
            {match.override.note ? <p className="t-secondary">{t('overriddenNote', { note: match.override.note })}</p> : null}
            {match.override.overriddenByMe ? <p className="t-secondary">{t('overriddenByYou')}</p> : null}
          </div>
        ) : null}
        {blocked && waiting ? (
          <div className="stack stack--sm">
            <strong>{t('resolveTitle')}</strong>
            <p className="t-secondary">{t('resolveHint')}</p>
            <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {canReceive && match.purchaseOrderId ? (
                <Link href={`/purchase-orders/${match.purchaseOrderId}/receive`}>{t('receiveLink', { order })}</Link>
              ) : null}
              {canOverride && !invoice.recordedByMe ? <Button onClick={() => setOverriding(true)}>{t('override')}</Button> : null}
            </span>
            {canOverride && invoice.recordedByMe ? <p className="t-secondary">{t('recordedByYou')}</p> : null}
          </div>
        ) : null}
      </div>
      <ReasonCodeDialog
        open={overriding}
        onClose={() => setOverriding(false)}
        title={t('overrideTitle', { number: invoice.number })}
        description={t('overrideHint')}
        codes={REASON_CODES.matchOverride}
        confirmLabel={t('override')}
        pending={override.isPending}
        error={<ErrorAlert error={override.error} />}
        onConfirm={(reasonCode) => override.mutate(reasonCode)}
      >
        <Field label={t('overrideNote')}>{(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </ReasonCodeDialog>
    </Card>
  );
}
