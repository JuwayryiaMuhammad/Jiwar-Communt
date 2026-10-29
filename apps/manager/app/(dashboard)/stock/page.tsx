'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, ButtonLink, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StockItem } from '@/lib/queries';

const UNITS = ['piece', 'metre', 'litre', 'kilogram', 'box', 'set', 'pair', 'roll'] as const;
type Show = 'all' | 'below';

function NewItemDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [sku, setSku] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [unit, setUnit] = useState<(typeof UNITS)[number]>('piece');
  const [reorderLevel, setReorderLevel] = useState('');
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/stock/items', {
          body: { sku: sku.trim(), nameEn: nameEn.trim(), nameAr: nameAr.trim(), unit, ...(reorderLevel ? { reorderLevel } : {}) },
        }),
      ),
    {
      invalidate: [keys.stockAll],
      onDone: (i) => {
        toast.show(`${i.sku} is added.`);
        router.push(`/stock/${i.id}`);
      },
    },
  );
  const ready = sku.trim() !== '' && nameEn.trim() !== '' && nameAr.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title="New item"
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Add item
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label="SKU" hint="Unique, e.g. VALVE-15. Never changes." error={fieldError(save.error, 'sku')}>
            {(p) => <Input {...p} value={sku} onChange={(e) => setSku(e.target.value)} />}
          </Field>
          <Field label="Unit" error={fieldError(save.error, 'unit')}>
            {(p) => (
              <Select {...p} value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="form__row">
          <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
            {(p) => <Input {...p} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
          <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
            {(p) => <Input {...p} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
          </Field>
        </div>
        <Field label="Reorder level" hint="Who keeps the store is told once stock falls to it." error={fieldError(save.error, 'reorderLevel')}>
          {(p) => <Input {...p} value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** The maintenance store's items (ADR 0065): what is held, what is reserved, what to reorder. */
export default function StockPage() {
  const { ready, can } = usePermissions();
  const [show, setShow] = useState<Show>('all');
  const [creating, setCreating] = useState(false);
  const filters = show === 'below' ? { below: 'true' as const } : {};
  const list = useCursorList(keys.stockItems(filters), (c) => fetchers.stockItems(filters, c), { enabled: can('stock.manage') });
  if (ready && !can('stock.manage'))
    return (
      <>
        <PageHeader title="Stock" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Stock"
        description="The maintenance store: items, what each store holds, and the technicians’ part requests."
        actions={
          <>
            <ButtonLink href="/stock/part-requests">Part requests</ButtonLink>
            <ButtonLink href="/stock/stores">Stores</ButtonLink>
            <Button variant="primary" onClick={() => setCreating(true)}>
              New item
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <Segmented<Show>
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: 'all', label: 'All' },
            { value: 'below', label: 'To reorder' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StockItem>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty="No items yet"
            columns={[
              {
                key: 's',
                header: 'SKU',
                cell: (i) => (
                  <Link className="table__link" href={`/stock/${i.id}`}>
                    {i.sku}
                  </Link>
                ),
              },
              { key: 'n', header: 'Name', cell: (i) => i.nameEn },
              { key: 'h', header: 'Held', cell: (i) => `${i.onHand} ${i.unit}` },
              { key: 'r', header: 'Reserved', cell: (i) => i.reserved },
              { key: 'c', header: 'Average cost', cell: (i) => (i.averageCost ? `${i.averageCost} EGP` : '—') },
              {
                key: 'b',
                header: 'Status',
                cell: (i) =>
                  !i.active ? <Badge>Retired</Badge> : i.belowReorderLevel ? <Badge tone="terracotta">Reorder</Badge> : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewItemDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
