'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, ForbiddenState, PageHeader, ReasonCodeDialog, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { AssetPicker } from '@/components/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/contracts';
import en from '@/messages/en/contracts';

/** One maintenance contract (ADR 0065): its terms, the assets it covers, its papers. */
export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const cm = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const contract = useQuery({ queryKey: keys.contract(id), queryFn: () => fetchers.contract(id), enabled: can('assets.manage') });
  // The covered assets are named one by one: they may be past any page of the register.
  const covering = useQueries({
    queries: (contract.data?.assetIds ?? []).map((assetId) => ({
      queryKey: keys.asset(assetId),
      queryFn: () => fetchers.asset(assetId),
      enabled: can('assets.manage'),
    })),
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
        toast.show(cm('saved'));
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
        toast.show(t('terminated'));
        setTerminating(false);
      },
    },
  );
  const addDoc = useAction(
    (fileId: string) =>
      unwrap(api.POST('/api/v1/maintenance/documents', { body: { contractId: id, fileId, kind: 'certificate', title: t('paperTitle') } })),
    { invalidate: [keys.documents({ contractId: id })], onDone: () => toast.show(t('added')) },
  );
  if (ready && !can('assets.manage'))
    return (
      <>
        <PageHeader title={t('contract')} />
        <ForbiddenState />
      </>
    );
  const c = contract.data;
  const covered = new Set(c?.assetIds ?? []);
  const byId = new Map(covering.map((q) => [q.data?.id ?? '', q.data]));
  return (
    <>
      <PageHeader
        title={c ? c.code : t('contract')}
        description={c ? `${label(c.kind)} · ${c.vendorName} · ${f.day(c.startsOn)} – ${f.day(c.endsOn)} · ${label(c.status)}` : undefined}
        actions={
          c && c.status !== 'terminated' ? (
            <Button onClick={() => setTerminating(true)}>{t('terminate')}</Button>
          ) : undefined
        }
      />
      <ErrorAlert error={setAssets.error ?? addDoc.error} />
      <QueryState query={contract}>
        {c ? (
          <div className="grid grid--main-aside">
            <Card flush>
              <CardHeader title={t('coveredAssets')} />
              <CardBody>
                {c.assetIds.length ? (
                  c.assetIds.map((a) => (
                    <p key={a}>
                      <Link className="table__link" href={`/assets/${a}`}>
                        {byId.get(a)?.code ?? t('asset')}
                      </Link>{' '}
                      {c.status !== 'terminated' ? (
                        <Button size="sm" onClick={() => setAssets.mutate(c.assetIds.filter((x) => x !== a))}>
                          {cm('remove')}
                        </Button>
                      ) : null}
                    </p>
                  ))
                ) : (
                  <p className="text-muted">{t('noAssets')}</p>
                )}
                {c.status !== 'terminated' ? (
                  <div className="row">
                    <AssetPicker aria-label={t('assetToAdd')} placeholder={t('addAnAsset')} hide={covered} value={adding} onChange={(id) => setAdding(id)} />
                    <Button size="sm" disabled={!adding} loading={setAssets.isPending} onClick={() => setAssets.mutate([...c.assetIds, adding])}>
                      {cm('add')}
                    </Button>
                  </div>
                ) : null}
              </CardBody>
            </Card>
            <div className="stack">
              <Card flush>
                <CardHeader title={t('terms')} />
                <CardBody>
                  <dl className="dl">
                    <dt>{t('vendorPhone')}</dt>
                    <dd className="ltr">{c.vendorPhone ?? '—'}</dd>
                    <dt>{t('aYear')}</dt>
                    <dd>{c.annualValue ? f.money(c.annualValue) : '—'}</dd>
                    <dt>{t('announced')}</dt>
                    <dd>{t('daysBefore', { days: c.noticeDays })}</dd>
                    {c.terminatedAt ? (
                      <>
                        <dt>{label('terminated')}</dt>
                        <dd>
                          {f.dateTime(c.terminatedAt)} · {label(c.terminationReason)}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title={t('papers')} />
                <CardBody>
                  {(docs.data?.data ?? []).map((d) => (
                    <p key={d.id}>{d.url ? <a href={d.url}>{d.title}</a> : d.title}</p>
                  ))}
                  <FileUpload purpose="asset_document" label={t('addScan')} onUploaded={(fileId) => addDoc.mutate(fileId)} />
                </CardBody>
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={terminating}
        onClose={() => setTerminating(false)}
        title={t('terminateTitle')}
        description={t('terminateDescription')}
        codes={REASON_CODES.contractTerminate}
        confirmLabel={t('terminate')}
        danger
        pending={terminate.isPending}
        error={<ErrorAlert error={terminate.error} />}
        onConfirm={(code) => terminate.mutate(code)}
      />
    </>
  );
}
