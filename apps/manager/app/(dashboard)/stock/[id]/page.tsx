'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StockMovement } from '@/lib/queries';

type Open = 'receive' | 'adjust' | 'transfer' | 'edit' | null;

/** One item of the store (ADR 0065): each store's level, its movements, and what changes them. */
export default function StockItemPage() {
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
      toast.show('Done.');
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
        <PageHeader title="Stock item" />
        <ForbiddenState />
      </>
    );
  const i = item.data;
  const active = (stores.data?.data ?? []).filter((s) => s.active);
  const storeSelect = (value: string, set: (v: string) => void, error: unknown, field: string, label = 'Store') => (
    <Field label={label} error={fieldError(error, field)}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">Select…</option>
          {active.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.nameEn}
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
        title={i ? `${i.sku} · ${i.nameEn}` : 'Stock item'}
        description={i ? `${i.onHand} ${i.unit} held · ${i.reserved} reserved · average ${i.averageCost ?? '—'} EGP` : undefined}
        actions={
          i?.active ? (
            <>
              <Button variant="primary" onClick={() => setOpen('receive')}>
                Receive
              </Button>
              <Button onClick={() => setOpen('adjust')}>Adjust</Button>
              <Button onClick={() => setOpen('transfer')}>Transfer</Button>
              <Button
                onClick={() => {
                  setReorderLevel(i.reorderLevel ?? '');
                  setOpen('edit');
                }}
              >
                Reorder level
              </Button>
              <Button onClick={() => update.mutate({ active: false })}>Retire</Button>
            </>
          ) : undefined
        }
      />
      <ErrorAlert error={update.error} />
      <QueryState query={item}>
        {i ? (
          <div className="grid grid--main-aside">
            <Card flush>
              <CardHeader title="Movements" />
              <QueryState query={movements}>
                <DataTable<StockMovement>
                  rows={movements.rows}
                  rowKey={(m) => m.id}
                  empty="No movement yet"
                  columns={[
                    { key: 'w', header: 'When', width: 170, cell: (m) => formatDateTime(m.occurredAt) },
                    { key: 'k', header: 'What', cell: (m) => humanize(m.kind) + (m.reasonCode ? ` (${humanize(m.reasonCode).toLowerCase()})` : '') },
                    { key: 'q', header: 'Quantity', cell: (m) => m.quantity },
                    { key: 's', header: 'Store', cell: (m) => active.find((s) => s.id === m.storeId)?.code ?? '—' },
                    { key: 'c', header: 'Cost', cell: (m) => (m.unitCost ? `${m.unitCost} EGP` : '—') },
                  ]}
                />
                <LoadMore query={movements} />
              </QueryState>
            </Card>
            <Card flush>
              <CardHeader title="By store" />
              <CardBody>
                {i.levels.length ? (
                  i.levels.map((l) => (
                    <p key={l.store.id}>
                      {l.store.code}: {l.quantity} held, {l.reserved} reserved
                    </p>
                  ))
                ) : (
                  <p className="text-muted">Nothing received yet.</p>
                )}
                <p className="text-muted">Reorder level: {i.reorderLevel ?? 'none'}</p>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </QueryState>
      <Dialog
        open={open === 'receive' || open === 'adjust' || open === 'transfer'}
        onClose={close}
        title={open === 'receive' ? 'Receive' : open === 'adjust' ? 'Adjust a level' : 'Transfer'}
        onSubmit={() => action.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={action.isPending}>
              Save
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={action.error} />
          {storeSelect(storeId, setStoreId, action.error, open === 'transfer' ? 'fromStoreId' : 'storeId', open === 'transfer' ? 'From' : 'Store')}
          {open === 'transfer' ? storeSelect(toStoreId, setToStoreId, action.error, 'toStoreId', 'To') : null}
          <Field
            label={open === 'adjust' ? 'Change' : 'Quantity'}
            hint={open === 'adjust' ? 'Signed: -2 takes two off.' : undefined}
            error={fieldError(action.error, open === 'adjust' ? 'delta' : 'quantity')}
          >
            {(p) => <Input {...p} value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
          </Field>
          {open === 'receive' ? (
            <>
              <Field label="Cost of one (EGP)" error={fieldError(action.error, 'unitCost')}>
                {(p) => <Input {...p} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />}
              </Field>
              <Field label="Delivery note or invoice" error={fieldError(action.error, 'reference')}>
                {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} />}
              </Field>
            </>
          ) : null}
          {open === 'adjust' ? (
            <Field label="Why" error={fieldError(action.error, 'reasonCode')}>
              {(p) => (
                <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                  <option value="">Select…</option>
                  {REASON_CODES.stockAdjust.map((c) => (
                    <option key={c} value={c}>
                      {humanize(c)}
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
        title="Reorder level"
        description="Who keeps the store is told once what it holds falls to this. Empty: no warning."
        onSubmit={() => update.mutate({ reorderLevel: reorderLevel.trim() || null })}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={update.isPending}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Level" error={fieldError(update.error, 'reorderLevel')}>
          {(p) => <Input {...p} value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />}
        </Field>
      </Dialog>
    </>
  );
}
