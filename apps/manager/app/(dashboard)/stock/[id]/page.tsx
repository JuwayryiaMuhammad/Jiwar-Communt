'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useNameOf } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StockMovement } from '@/lib/queries';
import ar from '@/messages/ar/stock-item';
import en from '@/messages/en/stock-item';

type Open = 'receive' | 'adjust' | 'transfer' | 'edit' | null;

/** One item of the store (ADR 0065): each store's level, its movements, and what changes them. */
export default function StockItemPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const f = useFormat();
  const nameOf = useNameOf();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const item = useQuery({ queryKey: keys.stockItem(id), queryFn: () => fetchers.stockItem(id), enabled: can('stock.manage') });
  const stores = useQuery({ queryKey: keys.stores, queryFn: fetchers.stores, enabled: can('stock.manage') });
  const movements = useCursorList(keys.stockMovements({ itemId: id }), (c) => fetchers.stockMovements({ itemId: id }, c), {
    enabled: can('stock.manage'),
  });
  const [open, setOpen] = useState<Open>(null);
  const [storeId, setStoreId] = useState('');
  const [toStoreId, setToStoreId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [reference, setReference] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [reorderLevel, setReorderLevel] = useState('');
  const close = () => {
    setOpen(null);
    setQuantity('');
    setUnitCost('');
    setReference('');
    setReasonCode('');
  };
  const refresh = {
    invalidate: [keys.stockAll],
    onDone: () => {
      toast.show(t('done'));
      close();
    },
  };
  const path = { params: { path: { id } } };
  const receive = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/stock/items/{id}/receive', {
          ...path,
          body: { storeId, quantity, unitCost, ...(reference.trim() ? { reference: reference.trim() } : {}) },
        }),
      ),
    refresh,
  );
  const adjust = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/stock/items/{id}/adjust', { ...path, body: { storeId, delta: quantity, reasonCode: reasonCode as (typeof REASON_CODES.stockAdjust)[number] } })),
    refresh,
  );
  const transfer = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/stock/items/{id}/transfer', { ...path, body: { fromStoreId: storeId, toStoreId, quantity } }),
      ),
    refresh,
  );
  const update = useAction(
    (body: { reorderLevel?: string | null; active?: boolean }) =>
      unwrap(api.PATCH('/api/v1/maintenance/stock/items/{id}', { ...path, body })),
    refresh,
  );
  if (ready && !can('stock.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const i = item.data;
  const active = (stores.data?.data ?? []).filter((s) => s.active);
  const storeSelect = (value: string, set: (v: string) => void, error: unknown, field: string, caption = t('store')) => (
    <Field label={caption} error={fieldError(error, field)}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{c('select')}</option>
          {active.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {nameOf(s)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const action = open === 'receive' ? receive : open === 'adjust' ? adjust : transfer;
  return (
    <>
      <PageHeader
        title={i ? `${i.sku} · ${nameOf(i)}` : t('title')}
        description={
          i
            ? t('summary', {
                onHand: i.onHand,
                unit: label(i.unit),
                reserved: i.reserved,
                average: i.averageCost ? f.money(i.averageCost) : '—',
              })
            : undefined
        }
        actions={
          i?.active ? (
            <>
              <Button variant="primary" onClick={() => setOpen('receive')}>
                {t('receive')}
              </Button>
              <Button onClick={() => setOpen('adjust')}>{t('adjust')}</Button>
              <Button onClick={() => setOpen('transfer')}>{t('transfer')}</Button>
              <Button
                onClick={() => {
                  setReorderLevel(i.reorderLevel ?? '');
                  setOpen('edit');
                }}
              >
                {t('reorderLevel')}
              </Button>
              <Button onClick={() => update.mutate({ active: false })}>{t('retire')}</Button>
            </>
          ) : undefined
        }
      />
      <ErrorAlert error={update.error} />
      <QueryState query={item}>
        {i ? (
          <div className="grid grid--main-aside">
            <Card flush>
              <CardHeader title={t('movements')} />
              <QueryState query={movements}>
                <DataTable<StockMovement>
                  rows={movements.rows}
                  rowKey={(m) => m.id}
                  empty={t('emptyMovements')}
                  columns={[
                    { key: 'w', header: t('col.when'), width: 170, cell: (m) => f.dateTime(m.occurredAt) },
                    {
                      key: 'k',
                      header: t('col.what'),
                      cell: (m) =>
                        m.reasonCode ? t('kindWithReason', { kind: label(m.kind), reason: label(m.reasonCode).toLowerCase() }) : label(m.kind),
                    },
                    { key: 'q', header: t('col.quantity'), cell: (m) => m.quantity },
                    { key: 's', header: t('col.store'), cell: (m) => active.find((s) => s.id === m.storeId)?.code ?? '—' },
                    { key: 'c', header: t('col.cost'), cell: (m) => (m.unitCost ? f.money(m.unitCost) : '—') },
                  ]}
                />
                <LoadMore query={movements} />
              </QueryState>
            </Card>
            <Card flush>
              <CardHeader title={t('byStore')} />
              <CardBody>
                {i.levels.length ? (
                  i.levels.map((l) => (
                    <p key={l.store.id}>
                      {t('levelLine', { code: l.store.code, quantity: l.quantity, reserved: l.reserved })}
                    </p>
                  ))
                ) : (
                  <p className="text-muted">{t('nothingReceived')}</p>
                )}
                <p className="text-muted">{t('reorderLevelLine', { level: i.reorderLevel ?? t('none') })}</p>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </QueryState>
      <Dialog
        open={open === 'receive' || open === 'adjust' || open === 'transfer'}
        onClose={close}
        title={open === 'receive' ? t('receive') : open === 'adjust' ? t('adjustTitle') : t('transfer')}
        onSubmit={() => action.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={action.isPending}>
              {c('save')}
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={action.error} />
          {storeSelect(storeId, setStoreId, action.error, open === 'transfer' ? 'fromStoreId' : 'storeId', open === 'transfer' ? t('from') : t('store'))}
          {open === 'transfer' ? storeSelect(toStoreId, setToStoreId, action.error, 'toStoreId', t('to')) : null}
          <Field
            label={open === 'adjust' ? t('change') : t('quantity')}
            hint={open === 'adjust' ? t('changeHint') : undefined}
            error={fieldError(action.error, open === 'adjust' ? 'delta' : 'quantity')}
          >
            {(p) => <Input {...p} value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
          </Field>
          {open === 'receive' ? (
            <>
              <Field label={t('unitCost')} error={fieldError(action.error, 'unitCost')}>
                {(p) => <Input {...p} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />}
              </Field>
              <Field label={t('reference')} error={fieldError(action.error, 'reference')}>
                {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} />}
              </Field>
            </>
          ) : null}
          {open === 'adjust' ? (
            <Field label={t('why')} error={fieldError(action.error, 'reasonCode')}>
              {(p) => (
                <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                  <option value="">{c('select')}</option>
                  {REASON_CODES.stockAdjust.map((code) => (
                    <option key={code} value={code}>
                      {label(code)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
      </Dialog>
      <Dialog
        open={open === 'edit'}
        onClose={close}
        title={t('reorderLevel')}
        description={t('reorderDescription')}
        onSubmit={() => update.mutate({ reorderLevel: reorderLevel.trim() || null })}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={update.isPending}>
              {c('save')}
            </Button>
          </>
        }
      >
        <Field label={t('level')} error={fieldError(update.error, 'reorderLevel')}>
          {(p) => <Input {...p} value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />}
        </Field>
      </Dialog>
    </>
  );
}
