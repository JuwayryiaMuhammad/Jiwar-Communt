'use client';

import { formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, ForbiddenState, PageHeader, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/** One maintenance contract (ADR 0065): its terms, the assets it covers, its papers. */
export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const contract = useQuery({ queryKey: keys.contract(id), queryFn: () => fetchers.contract(id), enabled: can('assets.manage') });
  const assets = useQuery({
    queryKey: keys.assets({ status: 'in_service' }),
    queryFn: () => fetchers.assets({ status: 'in_service' }, undefined, 100),
    enabled: can('assets.manage'),
  });
  const docs = useQuery({ queryKey: keys.documents({ contractId: id }), queryFn: () => fetchers.documents({ contractId: id }) });
  const [adding, setAdding] = useState('');
  const [terminating, setTerminating] = useState(false);
  const refresh = [keys.contractsAll, keys.contract(id)];
  const setAssets = useAction(
    (assetIds: string[]) => unwrap(api.PUT('/api/v1/maintenance/contracts/{id}/assets', { params: { path: { id } }, body: { assetIds } })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Saved.');
        setAdding('');
      },
    },
  );
  const terminate = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/maintenance/contracts/{id}/terminate', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Terminated.');
        setTerminating(false);
      },
    },
  );
  const addDoc = useAction(
    (fileId: string) =>
      unwrap(api.POST('/api/v1/maintenance/documents', { body: { contractId: id, fileId, kind: 'certificate', title: 'Contract' } })),
    { invalidate: [keys.documents({ contractId: id })], onDone: () => toast.show('Added.') },
  );
  if (ready && !can('assets.manage'))
    return (
      <>
        <PageHeader title="Contract" />
        <ForbiddenState />
      </>
    );
  const c = contract.data;
  const covered = new Set(c?.assetIds ?? []);
  const byId = new Map((assets.data?.data ?? []).map((a) => [a.id, a]));
  return (
    <>
      <PageHeader
        title={c ? c.code : 'Contract'}
        description={c ? `${humanize(c.kind)} · ${c.vendorName} · ${formatDate(c.startsOn)} – ${formatDate(c.endsOn)} · ${humanize(c.status)}` : undefined}
        actions={
          c && c.status !== 'terminated' ? (
            <Button onClick={() => setTerminating(true)}>Terminate</Button>
          ) : undefined
        }
      />
      <ErrorAlert error={setAssets.error ?? addDoc.error} />
      <QueryState query={contract}>
        {c ? (
          <div className="grid grid--main-aside">
            <Card flush>
              <CardHeader title="Covered assets" />
              <CardBody>
                {c.assetIds.length ? (
                  c.assetIds.map((a) => (
                    <p key={a}>
                      <Link className="table__link" href={`/assets/${a}`}>
                        {byId.get(a)?.code ?? 'Asset'}
                      </Link>{' '}
                      {c.status !== 'terminated' ? (
                        <Button size="sm" onClick={() => setAssets.mutate(c.assetIds.filter((x) => x !== a))}>
                          Remove
                        </Button>
                      ) : null}
                    </p>
                  ))
                ) : (
                  <p className="text-muted">None yet.</p>
                )}
                {c.status !== 'terminated' ? (
                  <div className="row">
                    <Select aria-label="Asset to add" value={adding} onChange={(e) => setAdding(e.target.value)}>
                      <option value="">Add an asset…</option>
                      {(assets.data?.data ?? [])
                        .filter((a) => !covered.has(a.id))
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.nameEn}
                          </option>
                        ))}
                    </Select>
                    <Button size="sm" disabled={!adding} loading={setAssets.isPending} onClick={() => setAssets.mutate([...c.assetIds, adding])}>
                      Add
                    </Button>
                  </div>
                ) : null}
              </CardBody>
            </Card>
            <div className="stack">
              <Card flush>
                <CardHeader title="Terms" />
                <CardBody>
                  <dl className="dl">
                    <dt>Vendor’s phone</dt>
                    <dd>{c.vendorPhone ?? '—'}</dd>
                    <dt>A year</dt>
                    <dd>{c.annualValue ? `${c.annualValue} EGP` : '—'}</dd>
                    <dt>Announced</dt>
                    <dd>{c.noticeDays} days before its end</dd>
                    {c.terminatedAt ? (
                      <>
                        <dt>Terminated</dt>
                        <dd>
                          {formatDateTime(c.terminatedAt)} · {humanize(c.terminationReason ?? '')}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title="Papers" />
                <CardBody>
                  {(docs.data?.data ?? []).map((d) => (
                    <p key={d.id}>{d.url ? <a href={d.url}>{d.title}</a> : d.title}</p>
                  ))}
                  <FileUpload purpose="asset_document" label="Add a scan" onUploaded={(fileId) => addDoc.mutate(fileId)} />
                </CardBody>
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={terminating}
        onClose={() => setTerminating(false)}
        title="Terminate the contract"
        description="It ends now, for good."
        codes={REASON_CODES.contractTerminate}
        confirmLabel="Terminate"
        danger
        pending={terminate.isPending}
        error={<ErrorAlert error={terminate.error} />}
        onConfirm={(code) => terminate.mutate(code)}
      />
    </>
  );
}
