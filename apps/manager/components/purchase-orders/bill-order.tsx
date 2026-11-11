'use client';

import { fieldError } from '@jiwar/api';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, DataTable, Field, Input, Select, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { fetchers, keys, type PurchaseOrder, type PurchaseOrderLine } from '@/lib/queries';
import commonAr from '@/messages/ar/po-common';
import ar from '@/messages/ar/fin-payables';
import commonEn from '@/messages/en/po-common';
import en from '@/messages/en/fin-payables';
import { billRowsFor, TAX_CODES, type BillRow, type ExtraRow, type TaxCode } from './po';

/** The orders an invoice can name: the approved ones and the closed ones, newest first. */
export function useOrdersToBill() {
  const approved = useQuery({
    queryKey: keys.purchaseOrdersToBill('approved'),
    queryFn: () => fetchers.purchaseOrders({ status: 'approved' }, undefined, 100),
  });
  const closed = useQuery({
    queryKey: keys.purchaseOrdersToBill('closed'),
    queryFn: () => fetchers.purchaseOrders({ status: 'closed' }, undefined, 50),
  });
  const orders = [...(approved.data?.data ?? []), ...(closed.data?.data ?? [])];
  return { orders, loading: approved.isLoading || closed.isLoading };
}

/**
 * The lines of an invoice against a purchase order (ADR 0094): each order
 * line with the quantity and the unit price billed (prefilled to what was
 * accepted and not yet billed, at the order’s price), and the extra lines the
 * order does not have, by amount. The API matches them to the order and the
 * receipts before the invoice is approved.
 */
export function OrderBilling({
  orderId,
  onOrder,
  rows,
  onRows,
  extras,
  onExtras,
  error,
}: {
  orderId: string;
  onOrder: (order: PurchaseOrder | null) => void;
  rows: BillRow[];
  onRows: (rows: BillRow[]) => void;
  extras: ExtraRow[];
  onExtras: (extras: ExtraRow[]) => void;
  error: unknown;
}) {
  const t = useT(en, ar);
  const w = useT(commonEn, commonAr);
  const f = useFormat();
  const label = useLabel();
  const { orders, loading } = useOrdersToBill();
  const order = orders.find((o) => o.id === orderId);
  const setRow = (i: number, patch: Partial<BillRow>) => onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setExtra = (i: number, patch: Partial<ExtraRow>) => onExtras(extras.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="stack">
      <Field label={t('record.pickOrder')} error={fieldError(error, 'purchaseOrderId')}>
        {(p) => (
          <Select
            {...p}
            value={orderId}
            onChange={(e) => {
              const picked = orders.find((o) => o.id === e.target.value) ?? null;
              onOrder(picked);
              onRows(picked ? billRowsFor(picked.lines) : []);
            }}
          >
            <option value="">{!loading && orders.length === 0 ? t('record.noOrders') : t('record.chooseOrder')}</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {`${o.reference} · ${o.vendorName} · ${f.money(o.total)}`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {order ? (
        <>
          <p className="hint">{t('record.orderLinesHint')}</p>
          <DataTable<PurchaseOrderLine>
            rows={order.lines}
            rowKey={(l) => l.id}
            columns={[
              { key: 'd', header: t('record.col.line'), cell: (l) => `${l.position}. ${l.description}` },
              {
                key: 'a',
                header: t('record.col.accepted'),
                cell: (l) => `${f.number(l.accepted, { maximumFractionDigits: 3 })} ${label(l.unit)}`,
              },
              {
                key: 'b',
                header: t('record.col.billed'),
                cell: (l) => `${f.number(l.invoiced, { maximumFractionDigits: 3 })} ${label(l.unit)}`,
              },
              {
                key: 'q',
                header: t('record.col.quantity'),
                cell: (l) => {
                  const i = rows.findIndex((r) => r.orderLineId === l.id);
                  return (
                    <Input
                      aria-label={t('record.col.quantity')}
                      inputMode="decimal"
                      className="ltr"
                      value={rows[i]?.quantity ?? ''}
                      onChange={(e) => setRow(i, { quantity: e.target.value })}
                    />
                  );
                },
              },
              {
                key: 'p',
                header: t('record.col.unitPrice'),
                cell: (l) => {
                  const i = rows.findIndex((r) => r.orderLineId === l.id);
                  return (
                    <Input
                      aria-label={t('record.col.unitPrice')}
                      inputMode="decimal"
                      className="ltr"
                      value={rows[i]?.unitPrice ?? ''}
                      onChange={(e) => setRow(i, { unitPrice: e.target.value })}
                    />
                  );
                },
              },
            ]}
          />
          <strong>{t('record.extraTitle')}</strong>
          <p className="hint">{t('record.extraHint')}</p>
          {extras.map((x, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label={t('record.line', { n: i + 1 })} error={fieldError(error, `lines.${rows.filter((r) => r.quantity.trim() !== '').length + i}.description`)}>
                {(p) => <Input {...p} maxLength={200} value={x.description} onChange={(e) => setExtra(i, { description: e.target.value })} />}
              </Field>
              <Field label={t('record.egp')}>
                {(p) => <Input {...p} inputMode="decimal" className="ltr" value={x.amount} onChange={(e) => setExtra(i, { amount: e.target.value })} />}
              </Field>
              <Field label={t('record.tax')}>
                {(p) => (
                  <Select {...p} value={x.taxCode} onChange={(e) => setExtra(i, { taxCode: e.target.value as TaxCode })}>
                    {TAX_CODES.map((c) => (
                      <option key={c} value={c}>
                        {w(`tax.${c}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button size="sm" variant="text" onClick={() => onExtras(extras.filter((_, j) => j !== i))}>
                {t('record.removeExtra')}
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" onClick={() => onExtras([...extras, { description: '', amount: '', taxCode: 'zero' }])} disabled={extras.length >= 10}>
              {t('record.addExtra')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
