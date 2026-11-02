'use client';

import { formatDate, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, DataTable, ForbiddenState, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Vendor } from '@/lib/queries';

type Doc = Vendor['documents'][number];

/** A vendor (ADR 0077): its details, papers, evaluations and suspension. */
export default function VendorPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [reason, setReason] = useState<string>(REASON_CODES.vendorSuspend[0]);
  const vendor = useQuery({ queryKey: keys.vendor(id), queryFn: () => fetchers.vendor(id), enabled: can('vendors.manage') });
  const suspend = useAction(
    () => unwrap(api.POST('/api/v1/staff/vendors/{id}/suspend', { params: { path: { id } }, body: { reasonCode: reason } })),
    { invalidate: [keys.vendorsAll], onDone: () => toast.show('The vendor is suspended.') },
  );
  const reinstate = useAction(
    () => unwrap(api.POST('/api/v1/staff/vendors/{id}/reinstate', { params: { path: { id } } })),
    { invalidate: [keys.vendorsAll], onDone: () => toast.show('The vendor is reinstated.') },
  );
  if (ready && !can('vendors.manage'))
    return (
      <>
        <PageHeader title="Vendor" />
        <ForbiddenState />
      </>
    );
  const v = vendor.data;
  return (
    <QueryState query={vendor}>
      {v ? (
        <>
          <PageHeader
            title={`${v.reference} · ${v.name}`}
            description={`${humanize(v.status)} · ${v.categories.map(humanize).join(', ')}`}
            actions={
              v.status === 'active' ? (
                <>
                  <Select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                    {REASON_CODES.vendorSuspend.map((r) => (
                      <option key={r} value={r}>
                        {humanize(r)}
                      </option>
                    ))}
                  </Select>
                  <Button loading={suspend.isPending} onClick={() => suspend.mutate()}>
                    Suspend
                  </Button>
                </>
              ) : (
                <Button loading={reinstate.isPending} onClick={() => reinstate.mutate()}>
                  Reinstate
                </Button>
              )
            }
          />
          <ErrorAlert error={suspend.error ?? reinstate.error} />
          <Card flush>
            <CardHeader title="Contacts" />
            <CardBody>
            <p>
              {v.contactName ?? '—'} · {v.phone ?? '—'} · {v.email ?? '—'}
            </p>
            <p>
              Contracts: {v.contracts.active} in force of {v.contracts.total}. Evaluations in the last year: {v.evaluations.count}
              {v.evaluations.averages.overall !== null ? `, averaging ${v.evaluations.averages.overall} of 5` : ''}.
            </p>
          </CardBody>
          </Card>
          <Card flush>
            <CardHeader title={v.documentsExpired ? 'Papers — one has lapsed' : 'Papers'} />
            <DataTable<Doc>
              rows={v.documents}
              rowKey={(d) => d.id}
              empty="No paper filed"
              columns={[
                { key: 'k', header: 'Kind', cell: (d) => humanize(d.kind) },
                { key: 'n', header: 'Number', cell: (d) => d.number ?? '—' },
                { key: 'e', header: 'Expires', cell: (d) => (d.expiresOn ? formatDate(d.expiresOn) : '—') },
                { key: 'x', header: '', cell: (d) => (d.expired ? 'Lapsed' : '') },
                {
                  key: 'f',
                  header: '',
                  cell: (d) =>
                    d.fileUrl ? (
                      <a className="table__link" href={d.fileUrl} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    ) : null,
                },
              ]}
            />
          </Card>
        </>
      ) : null}
    </QueryState>
  );
}
