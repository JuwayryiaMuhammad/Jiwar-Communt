'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useNameOf } from '@/components/maintenance-setup/names';
import { fetchers, keys, type StockItem } from '@/lib/queries';
import ar from '@/messages/ar/stock';
import en from '@/messages/en/stock';

const UNITS = ['piece', 'metre', 'litre', 'kilogram', 'box', 'set', 'pair', 'roll'] as const;
type Show = 'all' | 'below';

function NewItemDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
        toast.show(t('added', { sku: i.sku }));
        router.push(`/stock/${i.id}`);
      },
    },
  );
  const ready = sku.trim() !== '' && nameEn.trim() !== '' && nameAr.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newTitle')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('addItem')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label={t('sku')} hint={t('skuHint')} error={fieldError(save.error, 'sku')}>
            {(p) => <Input {...p} dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} />}
          </Field>
          <Field label={t('unit')} error={fieldError(save.error, 'unit')}>
            {(p) => (
              <Select {...p} value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {label(u)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="form__row">
          <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
            {(p) => <Input {...p} dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
          <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
            {(p) => <Input {...p} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
          </Field>
        </div>
        <Field label={t('reorderLevel')} hint={t('reorderHint')} error={fieldError(save.error, 'reorderLevel')}>
          {(p) => <Input {...p} value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** The maintenance store's items (ADR 0065): what is held, what is reserved, what to reorder. */
export default function StockPage() {
  const t = useT(en, ar);
  const label = useLabel();
  const f = useFormat();
  const nameOf = useNameOf();
  const { ready, can } = usePermissions();
  const [show, setShow] = useState<Show>('all');
  const [creating, setCreating] = useState(false);
  const filters = show === 'below' ? { below: 'true' as const } : {};
  const list = useCursorList(keys.stockItems(filters), (c) => fetchers.stockItems(filters, c), { enabled: can('stock.manage') });
  if (ready && !can('stock.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <ButtonLink href="/stock/part-requests">{t('partRequests')}</ButtonLink>
            <ButtonLink href="/stock/stores">{t('stores')}</ButtonLink>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('newItem')}
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <Segmented<Show>
          label={t('show')}
          value={show}
          onChange={setShow}
          options={[
            { value: 'all', label: t('show.all') },
            { value: 'below', label: t('show.below') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StockItem>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={t('empty')}
            columns={[
              {
                key: 's',
                header: t('col.sku'),
                cell: (i) => (
                  <Link className="table__link" href={`/stock/${i.id}`}>
                    {i.sku}
                  </Link>
                ),
              },
              { key: 'n', header: t('col.name'), cell: (i) => nameOf(i) },
              { key: 'h', header: t('col.held'), cell: (i) => `${i.onHand} ${label(i.unit)}` },
              { key: 'r', header: t('col.reserved'), cell: (i) => i.reserved },
              { key: 'c', header: t('col.cost'), cell: (i) => (i.averageCost ? f.money(i.averageCost) : '—') },
              {
                key: 'b',
                header: t('col.status'),
                cell: (i) =>
                  !i.active ? <Badge>{t('retired')}</Badge> : i.belowReorderLevel ? <Badge tone="terracotta">{t('reorder')}</Badge> : null,
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
