'use client';

import { ApiError, fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, ButtonLink, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Select, Textarea, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { FileUpload } from '@/components/file-upload';
import { useStoreChoices } from '@/components/purchase-orders/pickers';
import { leftToReceive, MAX_PHOTOS, needsStore, receiptLines, receiptReady, scaled, type LineKind, type ReceiveRow } from '@/components/purchase-orders/po';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PurchaseOrder, type PurchaseOrderLine } from '@/lib/queries';
import ar from '@/messages/ar/po-receive';
import en from '@/messages/en/po-receive';

const today = () => new Date().toLocaleDateString('en-CA');

function ReceiveForm({ order, lines, serviceOnly }: { order: PurchaseOrder; lines: PurchaseOrderLine[]; serviceOnly: boolean }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const router = useRouter();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<ReceiveRow[]>(() =>
    lines.map((l) => ({ orderLineId: l.id, accepted: '', rejected: '', rejectReason: '', note: '' })),
  );
  const [receivedOn, setReceivedOn] = useState(today());
  const [deliveryNote, setDeliveryNote] = useState('');
  const [note, setNote] = useState('');
  const [storeId, setStoreId] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const kinds = new Map<string, LineKind>(lines.map((l) => [l.id, l.kind]));
  const stock = needsStore(rows, kinds);
  const { stores, allowed: readsStores } = useStoreChoices(stock);
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/purchase-orders/{id}/receipts', {
          params: { path: { id: order.id }, header: { 'Idempotency-Key': key } },
          body: {
            receivedOn,
            ...(stock && storeId ? { storeId } : {}),
            ...(deliveryNote.trim() ? { deliveryNote: deliveryNote.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(photos.length ? { photoFileIds: photos } : {}),
            lines: receiptLines(rows),
          },
        }),
      ),
    {
      invalidate: [keys.purchaseOrdersAll, keys.stockAll],
      onDone: (r) => {
        toast.show(t('recorded', { reference: r.reference }));
        router.push(`/purchase-orders/${order.id}`);
      },
    },
  );
  const set = (i: number, patch: Partial<ReceiveRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const err = (field: string) => fieldError(record.error, field);
  // GOODS_RECEIPT_EXCEEDS_ORDER names the line and what is still accepted on it.
  const exceeds =
    record.error instanceof ApiError && record.error.code === 'GOODS_RECEIPT_EXCEEDS_ORDER'
      ? { lineId: String(record.error.params.lineId ?? ''), max: String(record.error.params.max ?? '0') }
      : null;
  const ready = receiptReady(rows) && receivedOn !== '' && (!stock || storeId !== '');
  return (
    <div className="stack">
      <Card flush>
        <DataTable<PurchaseOrderLine>
          rows={lines}
          rowKey={(l) => l.id}
          columns={[
            { key: 'd', header: t('col.line'), cell: (l) => `${l.position}. ${l.description}` },
            { key: 'o', header: t('col.ordered'), cell: (l) => `${f.number(l.quantity, { maximumFractionDigits: 3 })} ${label(l.unit)}` },
            {
              key: 'l',
              header: t('col.left'),
              cell: (l) => `${f.number(leftToReceive(l), { maximumFractionDigits: 3 })} ${label(l.unit)}`,
            },
            {
              key: 'a',
              header: t('col.accepted'),
              cell: (l) => {
                const i = lines.indexOf(l);
                return (
                  <div className="stack stack--sm">
                    <Input
                      aria-label={t('col.accepted')}
                      inputMode="decimal"
                      className="ltr"
                      value={rows[i]?.accepted ?? ''}
                      onChange={(e) => set(i, { accepted: e.target.value })}
                    />
                    {exceeds && exceeds.lineId === l.id ? (
                      <span className="field__error">{t('exceeds', { max: f.number(exceeds.max, { maximumFractionDigits: 3 }), unit: label(l.unit) })}</span>
                    ) : null}
                  </div>
                );
              },
            },
            {
              key: 'x',
              header: t('col.rejected'),
              cell: (l) => {
                const i = lines.indexOf(l);
                return (
                  <Input
                    aria-label={t('col.rejected')}
                    inputMode="decimal"
                    className="ltr"
                    value={rows[i]?.rejected ?? ''}
                    onChange={(e) => set(i, { rejected: e.target.value })}
                  />
                );
              },
            },
            {
              key: 'r',
              header: t('col.reason'),
              cell: (l) => {
                const i = lines.indexOf(l);
                const rejecting = (scaled(rows[i]?.rejected ?? '', 3) ?? 0n) > 0n;
                return (
                  <Select
                    aria-label={t('col.reason')}
                    value={rows[i]?.rejectReason ?? ''}
                    disabled={!rejecting}
                    onChange={(e) => set(i, { rejectReason: e.target.value })}
                  >
                    <option value="">{t('chooseReason')}</option>
                    {REASON_CODES.goodsRejection.map((r) => (
                      <option key={r} value={r}>
                        {label(r)}
                      </option>
                    ))}
                  </Select>
                );
              },
            },
            {
              key: 'n',
              header: t('col.note'),
              cell: (l) => {
                const i = lines.indexOf(l);
                return <Input aria-label={t('col.note')} maxLength={500} value={rows[i]?.note ?? ''} onChange={(e) => set(i, { note: e.target.value })} />;
              },
            },
          ]}
        />
      </Card>
      <Card>
        <div className="form">
          <div className="form__row">
            <Field label={t('receivedOn')} error={err('receivedOn')}>
              {(p) => <Input {...p} type="date" max={today()} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />}
            </Field>
            <Field label={t('deliveryNote')} error={err('deliveryNote')}>
              {(p) => <Input {...p} maxLength={60} className="ltr" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} />}
            </Field>
            {stock ? (
              readsStores ? (
                <Field label={t('store')} hint={t('storeHint')} error={err('storeId')}>
                  {(p) => (
                    <Select {...p} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                      <option value="">{t('chooseStore')}</option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {f.locale === 'ar' ? s.nameAr : s.nameEn}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : (
                <p className="hint">{t('storeNoAccess')}</p>
              )
            ) : null}
          </div>
          <Field label={t('note')} error={err('note')}>
            {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <div className="stack stack--sm">
            <span className="t-secondary">{t('photos')}</span>
            {photos.length ? (
              <span className="row" style={{ gap: 8 }}>
                <span className="t-secondary">{t('photoCount', { count: f.number(photos.length), max: f.number(MAX_PHOTOS) })}</span>
                <Button size="sm" variant="text" onClick={() => setPhotos([])}>
                  {t('removePhotos')}
                </Button>
              </span>
            ) : null}
            <FileUpload
              purpose="goods_receipt_photo"
              label={t('addPhoto')}
              disabled={photos.length >= MAX_PHOTOS}
              onUploaded={(fileId) => setPhotos((p) => [...p, fileId])}
            />
          </div>
        </div>
      </Card>
      {serviceOnly ? <p className="hint">{t('serviceOnly')}</p> : null}
      <ErrorAlert error={record.error} />
      <div className="row" style={{ gap: 8 }}>
        <Button variant="primary" loading={record.isPending} disabled={!ready} onClick={() => record.mutate(undefined)}>
          {t('submit')}
        </Button>
        <ButtonLink href={`/purchase-orders/${order.id}`}>{t('back')}</ButtonLink>
      </div>
    </div>
  );
}

/**
 * Receiving against an approved order (ADR 0094), in parts: per line the
 * quantity accepted (at most what the order and its tolerance still take),
 * what is rejected and why, with photos. Accepted stock goes into a store.
 * Who holds only the right to raise confirms the service lines.
 */
export default function ReceivePage() {
  const t = useT(en, ar);
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const everything = can('purchase_orders.receive');
  const allowed = everything || can('purchase_orders.raise');
  const q = useQuery({ queryKey: keys.purchaseOrder(id), queryFn: () => fetchers.purchaseOrder(id), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('forbiddenTitle')} />
        <ForbiddenState />
      </>
    );
  const o = q.data;
  // Lines with something still to come; the raiser alone confirms service lines.
  const lines = (o?.lines ?? []).filter((l) => (everything || l.kind === 'service') && Number(leftToReceive(l)) > 0);
  return (
    <QueryState query={q}>
      {o ? (
        <>
          <PageHeader
            back={<Back href={`/purchase-orders/${o.id}`} label={t('back')} />}
            title={t('title', { reference: o.reference })}
            description={t('description')}
          />
          {o.status !== 'approved' ? (
            <p className="hint">{t('notOpen')}</p>
          ) : lines.length === 0 ? (
            <p className="hint">{everything ? t('nothingLeft') : t('serviceOnly')}</p>
          ) : (
            <ReceiveForm order={o} lines={lines} serviceOnly={!everything} />
          )}
        </>
      ) : null}
    </QueryState>
  );
}
