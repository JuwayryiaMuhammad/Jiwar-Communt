'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type AssetType } from '@/lib/queries';
import ar from '@/messages/ar/ms-asset-types';
import en from '@/messages/en/ms-asset-types';
import { NameFields, namesReady, NO_NAMES, useNameOf } from './names';

function TypeDialog({ type, onClose }: { type: AssetType | null; onClose: () => void }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const nameOf = useNameOf();
  const toast = useToast();
  const categories = useQuery({ queryKey: keys.categories, queryFn: fetchers.categories });
  const [names, setNames] = useState(type ? { key: type.key, nameEn: type.nameEn, nameAr: type.nameAr } : NO_NAMES);
  const [categoryId, setCategoryId] = useState(type?.categoryId ?? '');
  const [life, setLife] = useState(type?.expectedLifeYears ? String(type.expectedLifeYears) : '');
  const [active, setActive] = useState(type?.active ?? true);
  const body = {
    nameEn: names.nameEn.trim(),
    nameAr: names.nameAr.trim(),
    categoryId,
    ...(life.trim() ? { expectedLifeYears: Number(life) } : {}),
  };
  const save = useAction(
    () =>
      type
        ? unwrap(
            api.PATCH('/api/v1/maintenance/asset-types/{id}', {
              params: { path: { id: type.id } },
              body: { ...body, ...(life.trim() ? {} : { expectedLifeYears: null }), active },
            }),
          )
        : unwrap(api.POST('/api/v1/maintenance/asset-types', { body: { ...body, key: names.key } })),
    {
      invalidate: [keys.assetTypes],
      onDone: (saved) => {
        toast.show(t('saved', { name: nameOf(saved) }));
        onClose();
      },
    },
  );
  const ready = namesReady(names, !type) && categoryId !== '';
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={type ? t('editTitle', { name: nameOf(type) }) : t('newTitle')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {type ? common('save') : t('addType')}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!type} example="chiller" />
        <div className="form__row">
          <Field label={t('category')} hint={t('categoryHint')} error={fieldError(save.error, 'categoryId')}>
            {(p) => (
              <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{common('select')}</option>
                {(categories.data?.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {nameOf(c)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('expectedLife')} error={fieldError(save.error, 'expectedLifeYears')}>
            {(p) => <Input {...p} type="number" min={1} max={100} value={life} onChange={(e) => setLife(e.target.value)} />}
          </Field>
        </div>
        {type ? <Checkbox label={t('inUse')} checked={active} onChange={(e) => setActive(e.target.checked)} /> : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The compound's kinds of asset (ADR 0064). */
export function AssetTypes() {
  const t = useT(en, ar);
  const common = useCommonT();
  const nameOf = useNameOf();
  const types = useQuery({ queryKey: keys.assetTypes, queryFn: fetchers.assetTypes });
  const [open, setOpen] = useState<AssetType | 'new' | null>(null);
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
          {t('newType')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={types}>
          <DataTable<AssetType>
            rows={types.data?.data}
            rowKey={(x) => x.id}
            columns={[
              {
                key: 'n',
                header: t('col.type'),
                cell: (x) => (
                  <span className="row" style={{ gap: 8 }}>
                    <span className="table__primary">{nameOf(x)}</span>
                    {!x.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'k', header: t('col.code'), cell: (x) => <span className="t-mono">{x.key}</span> },
              { key: 'l', header: t('col.life'), cell: (x) => (x.expectedLifeYears ? t('years', { n: x.expectedLifeYears }) : '—') },
              {
                key: 'x',
                header: <span className="visually-hidden">{common('actions')}</span>,
                className: 'table__actions',
                cell: (x) => (
                  <Button size="sm" onClick={() => setOpen(x)}>
                    {common('edit')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {open ? <TypeDialog type={open === 'new' ? null : open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
