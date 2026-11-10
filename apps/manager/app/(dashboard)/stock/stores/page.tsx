'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNameOf } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Store } from '@/lib/queries';
import ar from '@/messages/ar/stock-stores';
import en from '@/messages/en/stock-stores';

/** The maintenance store's stores (ADR 0065): retired with their stock in place, never deleted. */
export default function StoresPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const nameOf = useNameOf();
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
        toast.show(t('added'));
        setCreating(false);
        setCode('');
        setNameEn('');
        setNameAr('');
      },
    },
  );
  const retire = useAction(
    (id: string) => unwrap(api.PATCH('/api/v1/maintenance/stores/{id}', { params: { path: { id } }, body: { active: false } })),
    { invalidate: [keys.stockAll], onDone: () => toast.show(t('retired')) },
  );
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
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('newStore')}
          </Button>
        }
      />
      <ErrorAlert error={retire.error} />
      <Card flush>
        <QueryState query={stores}>
          <DataTable<Store>
            rows={stores.data?.data ?? []}
            rowKey={(s) => s.id}
            empty={t('empty')}
            columns={[
              { key: 'c', header: t('col.code'), cell: (s) => s.code },
              { key: 'n', header: t('col.name'), cell: (s) => nameOf(s) },
              { key: 'a', header: t('col.status'), cell: (s) => (s.active ? null : <Badge>{t('retiredBadge')}</Badge>) },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (s) =>
                  s.active ? (
                    <Button size="sm" loading={retire.isPending} onClick={() => retire.mutate(s.id)}>
                      {t('retire')}
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
        title={t('newStore')}
        onSubmit={() => create.mutate()}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!code.trim() || !nameEn.trim() || !nameAr.trim()}>
              {t('addStore')}
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={create.error} />
          <Field label={t('col.code')} hint={t('codeHint')} error={fieldError(create.error, 'code')}>
            {(p) => <Input {...p} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <div className="form__row">
            <Field label={t('nameEn')} error={fieldError(create.error, 'nameEn')}>
              {(p) => <Input {...p} dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
            </Field>
            <Field label={t('nameAr')} error={fieldError(create.error, 'nameAr')}>
              {(p) => <Input {...p} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
            </Field>
          </div>
        </div>
      </Dialog>
    </>
  );
}
