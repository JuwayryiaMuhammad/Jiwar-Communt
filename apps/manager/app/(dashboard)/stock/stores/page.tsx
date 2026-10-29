'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Store } from '@/lib/queries';

/** The maintenance store's stores (ADR 0065): retired with their stock in place, never deleted. */
export default function StoresPage() {
  const { ready, can } = usePermissions();
  const toast = useToast();
  const stores = useQuery({ queryKey: keys.stores, queryFn: fetchers.stores, enabled: can('stock.manage') });
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const create = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/stores', { body: { code: code.trim(), nameEn: nameEn.trim(), nameAr: nameAr.trim() } })),
    {
      invalidate: [keys.stockAll],
      onDone: () => {
        toast.show('Added.');
        setCreating(false);
        setCode('');
        setNameEn('');
        setNameAr('');
      },
    },
  );
  const retire = useAction(
    (id: string) => unwrap(api.PATCH('/api/v1/maintenance/stores/{id}', { params: { path: { id } }, body: { active: false } })),
    { invalidate: [keys.stockAll], onDone: () => toast.show('Retired.') },
  );
  if (ready && !can('stock.manage'))
    return (
      <>
        <PageHeader title="Stores" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Stores"
        description="Where the maintenance store keeps parts."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New store
          </Button>
        }
      />
      <ErrorAlert error={retire.error} />
      <Card flush>
        <QueryState query={stores}>
          <DataTable<Store>
            rows={stores.data?.data ?? []}
            rowKey={(s) => s.id}
            empty="No store yet"
            columns={[
              { key: 'c', header: 'Code', cell: (s) => s.code },
              { key: 'n', header: 'Name', cell: (s) => s.nameEn },
              { key: 'a', header: 'Status', cell: (s) => (s.active ? null : <Badge>Retired</Badge>) },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (s) =>
                  s.active ? (
                    <Button size="sm" loading={retire.isPending} onClick={() => retire.mutate(s.id)}>
                      Retire
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New store"
        onSubmit={() => create.mutate()}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!code.trim() || !nameEn.trim() || !nameAr.trim()}>
              Add store
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={create.error} />
          <Field label="Code" hint="Unique. Never changes." error={fieldError(create.error, 'code')}>
            {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <div className="form__row">
            <Field label="Name (English)" error={fieldError(create.error, 'nameEn')}>
              {(p) => <Input {...p} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
            </Field>
            <Field label="Name (Arabic)" error={fieldError(create.error, 'nameAr')}>
              {(p) => <Input {...p} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
            </Field>
          </div>
        </div>
      </Dialog>
    </>
  );
}
