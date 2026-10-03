'use client';

import { formatDate, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { emptyManager, ManagerFields, managerPayload, type NewManager } from '@/components/manager-fields';
import { api } from '@/lib/api';
import { keys, listTenants, type Tenant } from '@/lib/queries';

type StatusFilter = 'all' | 'active' | 'suspended';

function NewTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
        toast.show(`${tenant.name} is open. The manager can sign in with their email.`);
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
      title="New compound"
      description="Opens a compound with its first manager. Default roles are created with it."
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Open compound
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Compound name" error={fieldError(create.error, 'name')}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <p className="form__section">First manager</p>
        <ManagerFields value={manager} onChange={setManager} error={create.error} prefix="manager." />
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

function TenantsView() {
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
      (t) => (status === 'all' || t.status === status) && (!q || t.name.toLowerCase().includes(q)),
    );
  }, [tenants.rows, status, search]);

  return (
    <>
      <PageHeader
        title="Compounds"
        description="Each compound is a tenant with its own residents, staff and data."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            New compound
          </Button>
        }
      />
      <div className="toolbar">
        <div className="field" style={{ flex: '1 1 240px', maxWidth: 360 }}>
          <label className="visually-hidden" htmlFor="tenant-search">
            Search compounds
          </label>
          <div style={{ position: 'relative' }}>
            <Search
              aria-hidden
              style={{ position: 'absolute', left: 12, top: 12, width: 16, height: 16, color: 'var(--text-secondary)' }}
            />
            <Input
              id="tenant-search"
              placeholder="Search loaded compounds"
              style={{ paddingLeft: 36 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="spacer" />
        <Segmented<StatusFilter>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'suspended', label: 'Suspended' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={tenants}>
          <DataTable<Tenant>
            rows={rows}
            rowKey={(t) => t.id}
            empty={tenants.rows?.length ? 'No compound matches' : 'No compounds yet'}
            columns={[
              {
                key: 'name',
                header: 'Compound',
                cell: (t) => (
                  <Link className="table__link" href={`/tenants/${t.id}`}>
                    {t.name}
                  </Link>
                ),
              },
              { key: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
              { key: 'created', header: 'Opened', cell: (t) => <span className="t-num">{formatDate(t.createdAt)}</span> },
              { key: 'id', header: 'Tenant id', cell: (t) => <span className="t-mono t-secondary">{t.id}</span> },
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
