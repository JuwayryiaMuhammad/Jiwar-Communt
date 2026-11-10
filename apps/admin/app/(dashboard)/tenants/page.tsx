'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  Input,
  PageHeader,
  Segmented,
  StatusBadge,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { emptyManager, ManagerFields, managerPayload, type NewManager } from '@/components/manager-fields';
import { api } from '@/lib/api';
import { keys, listTenants, type Tenant } from '@/lib/queries';
import ar from '@/messages/ar/tenants';
import en from '@/messages/en/tenants';

const FILTERS = ['all', 'active', 'suspended'] as const;
type StatusFilter = (typeof FILTERS)[number];

function NewTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [manager, setManager] = useState<NewManager>(emptyManager);
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/platform/tenants', {
          body: { name: name.trim(), manager: managerPayload(manager) },
        }),
      ),
    {
      invalidate: [keys.tenants],
      onDone: (tenant) => {
        toast.show(t('new.opened', { name: tenant.name }));
        close();
        router.push(`/tenants/${tenant.id}`);
      },
    },
  );

  function close() {
    setName('');
    setManager(emptyManager);
    create.reset();
    onClose();
  }

  return (
    <Dialog
      wide
      open={open}
      onClose={close}
      title={t('newCompound')}
      description={t('new.description')}
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            {t('new.submit')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('new.name')} error={fieldError(create.error, 'name')}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <p className="form__section">{t('new.firstManager')}</p>
        <ManagerFields value={manager} onChange={setManager} error={create.error} prefix="manager." />
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

function TenantsView() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const tenants = useCursorList(keys.tenants, (cursor) => listTenants(cursor, 50));

  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true);
      router.replace('/tenants');
    }
  }, [params, router]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (tenants.rows ?? []).filter(
      (tenant) => (status === 'all' || tenant.status === status) && (!q || tenant.name.toLowerCase().includes(q)),
    );
  }, [tenants.rows, status, search]);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            {t('newCompound')}
          </Button>
        }
      />
      <div className="toolbar">
        <div className="field" style={{ flex: '1 1 240px', maxWidth: 360 }}>
          <label className="visually-hidden" htmlFor="tenant-search">
            {t('searchLabel')}
          </label>
          <div style={{ position: 'relative' }}>
            <Search
              aria-hidden
              style={{ position: 'absolute', insetInlineStart: 12, top: 12, width: 16, height: 16, color: 'var(--text-secondary)' }}
            />
            <Input
              id="tenant-search"
              placeholder={t('searchPlaceholder')}
              style={{ paddingInlineStart: 36 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="spacer" />
        <Segmented<StatusFilter>
          label={c('status')}
          value={status}
          onChange={setStatus}
          options={FILTERS.map((v) => ({ value: v, label: t(`filter.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={tenants}>
          <DataTable<Tenant>
            rows={rows}
            rowKey={(tenant) => tenant.id}
            empty={tenants.rows?.length ? t('emptyMatch') : t('empty')}
            columns={[
              {
                key: 'name',
                header: t('col.name'),
                cell: (tenant) => (
                  <Link className="table__link" href={`/tenants/${tenant.id}`}>
                    {tenant.name}
                  </Link>
                ),
              },
              { key: 'status', header: c('status'), cell: (tenant) => <StatusBadge status={tenant.status} /> },
              {
                key: 'created',
                header: t('col.opened'),
                cell: (tenant) => <span className="t-num">{fmt.date(tenant.createdAt)}</span>,
              },
              { key: 'id', header: t('col.id'), cell: (tenant) => <span className="t-mono t-secondary">{tenant.id}</span> },
            ]}
          />
          <LoadMore query={tenants} />
        </QueryState>
      </Card>
      <NewTenantDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export default function TenantsPage() {
  return (
    <Suspense>
      <TenantsView />
    </Suspense>
  );
}
