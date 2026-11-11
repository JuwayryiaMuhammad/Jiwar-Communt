'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, DataTable, ForbiddenState, PageHeader, Select, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { VendorContractors } from '@/components/vendors/contractors';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Vendor } from '@/lib/queries';
import ar from '@/messages/ar/ops-vendors';
import en from '@/messages/en/ops-vendors';

type Doc = Vendor['documents'][number];

/** A vendor (ADR 0077): its details, papers, evaluations and suspension. */
export default function VendorPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [reason, setReason] = useState<string>(REASON_CODES.vendorSuspend[0]);
  const vendor = useQuery({ queryKey: keys.vendor(id), queryFn: () => fetchers.vendor(id), enabled: can('vendors.manage') });
  const suspend = useAction(
    () => unwrap(api.POST('/api/v1/staff/vendors/{id}/suspend', { params: { path: { id } }, body: { reasonCode: reason } })),
    { invalidate: [keys.vendorsAll], onDone: () => toast.show(t('suspended')) },
  );
  const reinstate = useAction(
    () => unwrap(api.POST('/api/v1/staff/vendors/{id}/reinstate', { params: { path: { id } } })),
    { invalidate: [keys.vendorsAll], onDone: () => toast.show(t('reinstated')) },
  );
  if (ready && !can('vendors.manage'))
    return (
      <>
        <PageHeader title={t('vendor')} />
        <ForbiddenState />
      </>
    );
  const v = vendor.data;
  const average = v?.evaluations.averages.overall ?? null;
  return (
    <QueryState query={vendor}>
      {v ? (
        <>
          <PageHeader
            title={`${v.reference} · ${v.name}`}
            description={`${label(v.status)} · ${fmt.list(v.categories.map(label))}`}
            actions={
              v.status === 'active' ? (
                <>
                  <Select aria-label={t('reason')} value={reason} onChange={(e) => setReason(e.target.value)}>
                    {REASON_CODES.vendorSuspend.map((r) => (
                      <option key={r} value={r}>
                        {label(r)}
                      </option>
                    ))}
                  </Select>
                  <Button loading={suspend.isPending} onClick={() => suspend.mutate()}>
                    {t('suspend')}
                  </Button>
                </>
              ) : (
                <Button loading={reinstate.isPending} onClick={() => reinstate.mutate()}>
                  {t('reinstate')}
                </Button>
              )
            }
          />
          <ErrorAlert error={suspend.error ?? reinstate.error} />
          <Card flush>
            <CardHeader title={t('contacts')} />
            <CardBody>
              <p>
                {v.contactName ?? '—'} · {v.phone ? <bdi>{v.phone}</bdi> : '—'} · {v.email ? <bdi>{v.email}</bdi> : '—'}
              </p>
              <p>
                {t('contracts', { active: fmt.number(v.contracts.active), total: fmt.number(v.contracts.total) })}{' '}
                {average !== null
                  ? t('evaluationsAverage', { count: fmt.number(v.evaluations.count), average: fmt.number(average) })
                  : t('evaluations', { count: fmt.number(v.evaluations.count) })}
              </p>
            </CardBody>
          </Card>
          <Card flush>
            <CardHeader title={v.documentsExpired ? t('papersLapsed') : t('papers')} />
            <DataTable<Doc>
              rows={v.documents}
              rowKey={(d) => d.id}
              empty={t('noPaper')}
              columns={[
                { key: 'k', header: t('col.kind'), cell: (d) => label(d.kind) },
                { key: 'n', header: t('col.number'), cell: (d) => d.number ?? '—' },
                { key: 'e', header: t('col.expires'), cell: (d) => (d.expiresOn ? fmt.day(d.expiresOn) : '—') },
                { key: 'x', header: '', cell: (d) => (d.expired ? t('lapsed') : '') },
                {
                  key: 'f',
                  header: '',
                  cell: (d) =>
                    d.fileUrl ? (
                      <a className="table__link" href={d.fileUrl} target="_blank" rel="noreferrer">
                        {t('open')}
                      </a>
                    ) : null,
                },
              ]}
            />
          </Card>
          <VendorContractors vendor={v} />
        </>
      ) : null}
    </QueryState>
  );
}
