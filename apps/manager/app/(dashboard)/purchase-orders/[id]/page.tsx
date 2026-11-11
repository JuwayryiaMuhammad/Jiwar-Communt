'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  Field,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Stat,
  StatusBadge,
  Textarea,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back, SectionHeader } from '@/components/community/bits';
import { AmendDialog, ApproveDialog } from '@/components/purchase-orders/order-dialogs';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GoodsReceipt, type PurchaseOrder, type PurchaseOrderLine } from '@/lib/queries';
import commonAr from '@/messages/ar/po-common';
import ar from '@/messages/ar/po-order';
import commonEn from '@/messages/en/po-common';
import en from '@/messages/en/po-order';

type Revision = PurchaseOrder['revisions'][number];
const READERS = ['purchase_orders.raise', 'purchase_orders.receive', 'purchases.approve', 'finance.payables', 'finance.payables_approve'];

function Receipt({ r }: { r: GoodsReceipt }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  return (
    <div className="stack stack--sm">
      <strong>{t('receiptHead', { reference: r.reference, day: f.day(r.receivedOn) })}</strong>
      {r.deliveryNote ? <span className="t-secondary">{t('deliveryNote', { number: r.deliveryNote })}</span> : null}
      <DataTable<GoodsReceipt['lines'][number]>
        rows={r.lines}
        rowKey={(l) => l.purchaseOrderLineId}
        columns={[
          { key: 'd', header: t('col.line'), cell: (l) => l.description },
          { key: 'a', header: t('col.accepted'), cell: (l) => `${f.number(l.accepted, { maximumFractionDigits: 3 })} ${label(l.unit)}` },
          {
            key: 'x',
            header: t('col.rejected'),
            cell: (l) => (Number(l.rejected) > 0 ? `${f.number(l.rejected, { maximumFractionDigits: 3 })} ${label(l.unit)}` : '—'),
          },
          { key: 'r', header: t('col.reason'), cell: (l) => (l.rejectReason ? label(l.rejectReason) : '—') },
          { key: 'n', header: t('col.note'), cell: (l) => l.note ?? '—' },
        ]}
      />
      {r.note ? <span className="t-secondary">{r.note}</span> : null}
      {r.photos.length ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          {r.photos.map((p) =>
            p.url ? (
              <a key={p.fileId} href={p.url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
                <img
                  src={p.url}
                  alt={t('photoAlt')}
                  referrerPolicy="no-referrer"
                  style={{ maxWidth: 160, maxHeight: 120, borderRadius: 8, display: 'block' }}
                />
              </a>
            ) : (
              <span key={p.fileId} className="t-secondary">
                {t('photoGone')}
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function RevisionCard({ r, order }: { r: Revision; order: PurchaseOrder }) {
  const t = useT(en, ar);
  const w = useT(commonEn, commonAr);
  const f = useFormat();
  const label = useLabel();
  return (
    <div className="stack stack--sm">
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong>{t('revisionHead', { n: f.number(r.revision) })}</strong>
        <StatusBadge status={r.status} label={t(`revision.${r.status}`)} />
        {r.status === 'approved' && r.revision === order.revision ? <Badge tone="green">{t('inForce')}</Badge> : null}
      </span>
      <span className="t-secondary">{t('revisionMeta', { when: f.dateTime(r.requestedAt), delivery: f.day(r.deliveryOn), total: f.money(r.total) })}</span>
      {r.reasonCode ? <span>{t('revisionReason', { reason: label(r.reasonCode) })}</span> : null}
      {r.note ? <span className="t-secondary">{r.note}</span> : null}
      {r.status === 'rejected' && r.rejectReason ? <span>{t('revisionRejected', { reason: label(r.rejectReason) })}</span> : null}
      {r.decisionNote ? <span className="t-secondary">{t('revisionDecision', { note: r.decisionNote })}</span> : null}
      <DataTable<Revision['lines'][number]>
        rows={r.lines}
        rowKey={(l) => l.id}
        columns={[
          { key: 'd', header: t('col.line'), cell: (l) => l.description },
          { key: 'q', header: t('col.ordered'), cell: (l) => `${f.number(l.quantity, { maximumFractionDigits: 3 })} ${label(l.unit)}` },
          { key: 'p', header: t('col.price'), cell: (l) => f.money(l.unitPrice) },
          { key: 'v', header: t('col.vat'), cell: (l) => w(`tax.${l.taxCode}`) },
        ]}
      />
    </div>
  );
}

/** Where the order stands with the vendor: when the revision in force went to it and whether its contractors acknowledged it. */
function VendorStanding({ o }: { o: PurchaseOrder }) {
  const t = useT(en, ar);
  const f = useFormat();
  if (o.status !== 'approved' && o.status !== 'closed') return null;
  if (!o.sentAt) return <p className="t-secondary">{t('notSent')}</p>;
  return (
    <p className="t-secondary">
      {t('sentOn', { when: f.dateTime(o.sentAt), revision: f.number(o.sentRevision ?? o.revision) })}{' '}
      {o.sentRevision !== o.revision ? t('sentOld', { sent: f.number(o.sentRevision ?? 0), current: f.number(o.revision) }) : null}{' '}
      {o.acknowledgedAt
        ? o.acknowledgedRevision === o.revision
          ? t('acknowledgedOn', { revision: f.number(o.acknowledgedRevision ?? o.revision), when: f.dateTime(o.acknowledgedAt) })
          : t('acknowledgedOld', { revision: f.number(o.acknowledgedRevision ?? 0) })
        : t('notAcknowledged')}
    </p>
  );
}

/**
 * One purchase order (ADR 0094): where it stands, what is ordered, accepted
 * and invoiced line by line, its revisions, the goods receipts and the
 * invoices that name it; and what the caller may do with it.
 */
export default function PurchaseOrderPage() {
  const t = useT(en, ar);
  const w = useT(commonEn, commonAr);
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = READERS.some((p) => can(p));
  const q = useQuery({ queryKey: keys.purchaseOrder(id), queryFn: () => fetchers.purchaseOrder(id), enabled: allowed });
  const [approving, setApproving] = useState(false);
  const [amending, setAmending] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [note, setNote] = useState('');
  const [fileError, setFileError] = useState<unknown>(null);
  const o = q.data;
  const invalidate = [keys.purchaseOrdersAll, keys.budgetsAll, keys.purchasesAll];
  const path = { params: { path: { id } } };
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/purchase-orders/{id}/reject', { ...path, body: { reasonCode, ...(note.trim() ? { note: note.trim() } : {}) } })),
    {
      invalidate,
      onDone: (r) => {
        toast.show(o?.status === 'requested' ? t('rejected', { reference: r.reference }) : t('rejectedRevision', { n: f.number(o?.pendingRevision ?? 0), reference: r.reference }));
        setRejecting(false);
        setNote('');
      },
    },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/purchase-orders/{id}/cancel', { ...path, body: { reasonCode } })),
    {
      invalidate,
      onDone: (r) => {
        toast.show(r.status === 'cancelled' ? t('calledOff', { reference: r.reference }) : t('cancelledRest', { reference: r.reference }));
        setCancelling(false);
      },
    },
  );
  const withdraw = useAction(() => unwrap(api.POST('/api/v1/staff/purchase-orders/{id}/withdraw-revision', path)), {
    invalidate,
    onDone: () => toast.show(t('withdrawn', { n: f.number(o?.pendingRevision ?? 0) })),
  });
  const send = useAction(() => unwrap(api.POST('/api/v1/staff/purchase-orders/{id}/send', path)), {
    invalidate: [keys.purchaseOrdersAll],
    onDone: (r) => toast.show(t('sentToVendor', { reference: r.reference })),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const waitingFirst = o?.status === 'requested';
  const waitingRevision = o?.status === 'approved' && o.pendingRevision !== null;
  const decisionRevision = o?.revisions.find((r) => r.status === 'requested');
  const askedByMe = decisionRevision?.requestedByMe ?? o?.raisedByMe ?? false;
  const canDecide = can('purchases.approve') && !askedByMe;
  const canRaise = can('purchase_orders.raise');
  const live = o?.status === 'approved';
  const pdf = () => download(`/api/v1/staff/purchase-orders/${id}/pdf`, {}, `${o?.reference ?? 'purchase-order'}.pdf`).catch(setFileError);
  return (
    <QueryState query={q}>
      {o ? (
        <>
          <PageHeader
            back={<Back href="/purchase-orders" label={t('back')} />}
            title={
              <>
                <span className="ltr">{o.reference}</span> · {o.vendorName}
              </>
            }
            description={t('summary', { status: w(`status.${o.status}`), delivery: f.day(o.deliveryOn), raised: f.date(o.raisedAt) })}
            actions={
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {(waitingFirst || waitingRevision) && canDecide ? (
                  <>
                    <Button variant="primary" onClick={() => setApproving(true)}>
                      {waitingFirst ? t('approve') : t('approveRevision', { n: f.number(o.pendingRevision ?? 0) })}
                    </Button>
                    <Button onClick={() => setRejecting(true)}>{waitingFirst ? t('reject') : t('rejectRevision', { n: f.number(o.pendingRevision ?? 0) })}</Button>
                  </>
                ) : null}
                {waitingRevision && askedByMe && canRaise ? (
                  <Button loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
                    {t('withdraw', { n: f.number(o.pendingRevision ?? 0) })}
                  </Button>
                ) : null}
                {live && !waitingRevision && canRaise ? <Button onClick={() => setAmending(true)}>{t('amend')}</Button> : null}
                {live && canRaise ? (
                  <Button loading={send.isPending} onClick={() => send.mutate(undefined)}>
                    {!o.sentAt ? t('send') : o.sentRevision !== o.revision ? t('sendRevision', { n: f.number(o.revision) }) : t('sendAgain')}
                  </Button>
                ) : null}
                {live && (can('purchase_orders.receive') || canRaise) ? (
                  <ButtonLink href={`/purchase-orders/${o.id}/receive`} variant={waitingRevision ? 'secondary' : 'primary'}>
                    {t('receive')}
                  </ButtonLink>
                ) : null}
                {(waitingFirst || (live && !waitingRevision)) && (canRaise || can('purchases.approve')) ? (
                  <Button variant="danger" onClick={() => setCancelling(true)}>
                    {waitingFirst ? t('callOff') : t('cancelRest')}
                  </Button>
                ) : null}
                {canRaise || can('purchase_orders.receive') || can('purchases.approve') ? <Button onClick={() => void pdf()}>{t('pdf')}</Button> : null}
              </span>
            }
          />
          <ErrorAlert error={fileError ?? send.error ?? withdraw.error} />
          {(waitingFirst || waitingRevision) && askedByMe ? <p className="t-secondary">{waitingFirst ? t('raisedByYou') : t('askedByYou')}</p> : null}
          <p className="t-secondary">{t('from', { source: t(`from.${o.source}`) })}</p>
          {o.status === 'rejected' ? <p>{t('rejectedWith', { reason: label(o.rejectReason) })}</p> : null}
          {o.status === 'cancelled' ? <p>{t('cancelledWith', { reason: label(o.cancelReason) })}</p> : null}
          {o.status === 'closed' && o.closeReason ? <p>{t(`closed.${o.closeReason}`)}</p> : null}
          {o.decisionNote ? <p className="t-secondary">{o.decisionNote}</p> : null}
          {o.note ? <p className="t-secondary">{o.note}</p> : null}
          <VendorStanding o={o} />
          <div className="grid grid--stats">
            <Stat label={t('net')} value={f.money(o.subtotal)} />
            <Stat label={t('vat')} value={f.money(o.tax)} />
            <Stat label={t('total')} value={f.money(o.total)} />
            <Stat label={t('committed')} value={f.money(o.committed)} />
          </div>
          <Card flush>
            <SectionHeader title={t('linesTitle')} />
            <DataTable<PurchaseOrderLine>
              rows={o.lines}
              rowKey={(l) => l.id}
              columns={[
                { key: 'd', header: t('col.line'), cell: (l) => `${l.position}. ${l.description}` },
                { key: 'q', header: t('col.ordered'), cell: (l) => `${f.number(l.quantity, { maximumFractionDigits: 3 })} ${label(l.unit)}` },
                { key: 'a', header: t('col.accepted'), cell: (l) => f.number(l.accepted, { maximumFractionDigits: 3 }) },
                { key: 'x', header: t('col.rejected'), cell: (l) => f.number(l.rejected, { maximumFractionDigits: 3 }) },
                { key: 'i', header: t('col.invoiced'), cell: (l) => f.number(l.invoiced, { maximumFractionDigits: 3 }) },
                { key: 'p', header: t('col.price'), cell: (l) => f.money(l.unitPrice) },
                { key: 'v', header: t('col.vat'), cell: (l) => `${w(`tax.${l.taxCode}`)} · ${f.money(l.tax)}` },
                { key: 'n', header: t('col.net'), cell: (l) => f.money(l.net) },
              ]}
            />
          </Card>
          <Card flush>
            <SectionHeader title={t('revisionsTitle')} description={t('revisionsHint')} />
            <div className="stack" style={{ padding: 16 }}>
              {o.revisions.map((r) => (
                <RevisionCard key={r.revision} r={r} order={o} />
              ))}
            </div>
          </Card>
          <Card>
            <SectionHeader title={t('receiptsTitle')} />
            {o.receipts.length ? (
              <div className="stack">
                {o.receipts.map((r) => (
                  <Receipt key={r.id} r={r} />
                ))}
              </div>
            ) : (
              <p className="t-secondary">{t('receiptsEmpty')}</p>
            )}
          </Card>
          <Card flush>
            <SectionHeader title={t('invoicesTitle')} />
            <DataTable<PurchaseOrder['invoices'][number]>
              rows={o.invoices}
              rowKey={(i) => i.id}
              empty={t('invoicesEmpty')}
              columns={[
                {
                  key: 'r',
                  header: t('col.invoice'),
                  cell: (i) => (
                    <Link className="ltr" href={`/finance/payables/${i.id}`}>
                      {i.reference}
                    </Link>
                  ),
                },
                { key: 's', header: t('col.status'), cell: (i) => <StatusBadge status={i.status} /> },
                { key: 't', header: t('col.total'), cell: (i) => f.money(i.total) },
              ]}
            />
          </Card>
          {approving ? <ApproveDialog order={o} revision={o.pendingRevision} onClose={() => setApproving(false)} /> : null}
          {amending ? <AmendDialog order={o} onClose={() => setAmending(false)} /> : null}
          <ReasonCodeDialog
            open={rejecting}
            onClose={() => setRejecting(false)}
            title={waitingFirst ? t('rejectTitle', { reference: o.reference }) : t('rejectRevisionTitle', { n: f.number(o.pendingRevision ?? 0), reference: o.reference })}
            codes={REASON_CODES.purchaseOrderReject}
            confirmLabel={waitingFirst ? t('reject') : t('rejectRevision', { n: f.number(o.pendingRevision ?? 0) })}
            danger
            pending={reject.isPending}
            error={<ErrorAlert error={reject.error} />}
            onConfirm={(reasonCode) => reject.mutate(reasonCode)}
          >
            <Field label={t('rejectNote')}>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </ReasonCodeDialog>
          <ReasonCodeDialog
            open={cancelling}
            onClose={() => setCancelling(false)}
            title={waitingFirst ? t('callOffTitle', { reference: o.reference }) : t('cancelRestTitle', { reference: o.reference })}
            description={waitingFirst ? t('callOffHint') : t('cancelRestHint')}
            codes={REASON_CODES.purchaseOrderCancel}
            confirmLabel={waitingFirst ? t('callOff') : t('cancelRest')}
            danger
            pending={cancel.isPending}
            error={<ErrorAlert error={cancel.error} />}
            onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
          />
        </>
      ) : null}
    </QueryState>
  );
}
