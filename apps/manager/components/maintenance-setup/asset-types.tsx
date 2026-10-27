'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type AssetType } from '@/lib/queries';
import { NameFields, namesReady, NO_NAMES } from './names';

function TypeDialog({ type, onClose }: { type: AssetType | null; onClose: () => void }) {
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
      onDone: (t) => {
        toast.show(`${t.nameEn} is saved.`);
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
      title={type ? `Edit ${type.nameEn}` : 'New asset type'}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {type ? 'Save' : 'Add type'}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!type} example="chiller" />
        <div className="form__row">
          <Field label="Category" hint="Its technicians work on these assets." error={fieldError(save.error, 'categoryId')}>
            {(p) => (
              <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Select…</option>
                {(categories.data?.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Expected life (years)" error={fieldError(save.error, 'expectedLifeYears')}>
            {(p) => <Input {...p} type="number" min={1} max={100} value={life} onChange={(e) => setLife(e.target.value)} />}
          </Field>
        </div>
        {type ? <Checkbox label="In use" checked={active} onChange={(e) => setActive(e.target.checked)} /> : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The compound's kinds of asset (ADR 0064). */
export function AssetTypes() {
  const types = useQuery({ queryKey: keys.assetTypes, queryFn: fetchers.assetTypes });
  const [open, setOpen] = useState<AssetType | 'new' | null>(null);
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
          New type
        </Button>
      </div>
      <Card flush>
        <QueryState query={types}>
          <DataTable<AssetType>
            rows={types.data?.data}
            rowKey={(t) => t.id}
            columns={[
              {
                key: 'n',
                header: 'Type',
                cell: (t) => (
                  <span className="row" style={{ gap: 8 }}>
                    <span className="table__primary">{t.nameEn}</span>
                    {!t.active ? <Badge tone="beige">Retired</Badge> : null}
                  </span>
                ),
              },
              { key: 'k', header: 'Code', cell: (t) => <span className="t-mono">{t.key}</span> },
              { key: 'l', header: 'Expected life', cell: (t) => (t.expectedLifeYears ? `${t.expectedLifeYears} years` : '—') },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (t) => (
                  <Button size="sm" onClick={() => setOpen(t)}>
                    Edit
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
