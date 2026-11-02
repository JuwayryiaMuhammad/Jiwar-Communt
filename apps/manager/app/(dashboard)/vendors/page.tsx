'use client';

import { fieldError, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type VendorSummary } from '@/lib/queries';

type Status = VendorSummary['status'] | '';

function NewVendorDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [f, setF] = useState({ name: '', phone: '', email: '', taxNumber: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/vendors', {
          body: {
            name: f.name.trim(),
            ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
            ...(f.email.trim() ? { email: f.email.trim() } : {}),
            ...(f.taxNumber.trim() ? { taxNumber: f.taxNumber.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.vendorsAll],
      onDone: (v) => {
        toast.show(`${v.name} is registered as ${v.reference}.`);
        router.push(`/vendors/${v.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="New vendor"
      onSubmit={() => f.name.trim() && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.name.trim()}>
            Register
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label="Name" hint="Unique in the compound." error={fieldError(save.error, 'name')}>
          {(p) => <Input {...p} value={f.name} onChange={set('name')} />}
        </Field>
        <div className="form__row">
          <Field label="Phone" error={fieldError(save.error, 'phone')}>
            {(p) => <Input {...p} value={f.phone} onChange={set('phone')} />}
          </Field>
          <Field label="Email" error={fieldError(save.error, 'email')}>
            {(p) => <Input {...p} value={f.email} onChange={set('email')} />}
          </Field>
        </div>
        <Field label="Tax number" error={fieldError(save.error, 'taxNumber')}>
          {(p) => <Input {...p} value={f.taxNumber} onChange={set('taxNumber')} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** The compound's vendor register (ADR 0077). */
export default function VendorsPage() {
  const { ready, can } = usePermissions();
  const [status, setStatus] = useState<Status>('active');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const filters = { status, ...(q.trim() ? { q: q.trim() } : {}) };
  const list = useCursorList(keys.vendors(filters), (c) => fetchers.vendors(filters, c), { enabled: can('vendors.manage') });
  if (ready && !can('vendors.manage'))
    return (
      <>
        <PageHeader title="Vendors" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Vendors"
        description="The companies the compound buys from and contracts with: their papers, evaluations and suspensions."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New vendor
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'suspended', label: 'Suspended' },
            { value: '', label: 'All' },
          ]}
        />
        <Input aria-label="Search by name" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<VendorSummary>
            rows={list.rows}
            rowKey={(v) => v.id}
            empty="No vendor"
            columns={[
              {
                key: 'r',
                header: 'Vendor',
                cell: (v) => (
                  <Link className="table__link" href={`/vendors/${v.id}`}>
                    {v.reference} · {v.name}
                  </Link>
                ),
              },
              { key: 'c', header: 'Trades', cell: (v) => v.categories.map(humanize).join(', ') },
              { key: 's', header: 'Status', cell: (v) => humanize(v.status) },
              { key: 'p', header: 'Phone', cell: (v) => v.phone ?? '—' },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewVendorDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
