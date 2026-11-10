'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CompoundExport } from '@/lib/queries';
import ar from '@/messages/ar/compound-export';
import en from '@/messages/en/compound-export';

/**
 * The compound's export (ADR 0086): its operational data as one archive —
 * the register, the work and its costs, the stock, the common meters, the
 * budget and the capital plans — never a person's. After a fresh code,
 * once a day; ready for 7 days.
 */
export default function CompoundExportPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('compound.export');
  const list = useQuery({ queryKey: keys.compoundExports(), queryFn: fetchers.compoundExports, enabled: allowed, refetchInterval: 15_000 });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const request = useAction(() => unwrap(api.POST('/api/v1/staff/compound-exports', {})), {
    invalidate: [keys.compoundExports()],
    onDone: () => toast.show(t('asked')),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const open = async (x: CompoundExport) => {
    setError(null);
    try {
      const link = await unwrap(api.GET('/api/v1/staff/compound-exports/{id}/download', { params: { path: { id: x.id } } }));
      window.open(link.url, '_blank', 'noopener');
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" loading={request.isPending} onClick={() => setConfirming(true)}>
            {t('export')}
          </Button>
        }
      />
      <ErrorAlert error={request.error ?? error} />
      <QueryState query={list}>
        <Card flush>
          <DataTable<CompoundExport>
            rows={list.data?.data ?? []}
            rowKey={(x) => x.id}
            empty={t('empty')}
            columns={[
              { key: 'asked', header: t('askedOn'), cell: (x) => f.dateTime(x.requestedAt) },
              { key: 'status', header: c('status'), cell: (x) => <Badge tone={x.status === 'ready' ? 'green' : 'beige'}>{label(x.status)}</Badge> },
              { key: 'rows', header: t('rows'), cell: (x) => (x.rows === null || x.rows === undefined ? '—' : f.number(x.rows)) },
              {
                key: 'file',
                header: '',
                cell: (x) =>
                  x.status === 'ready' ? (
                    <Button size="sm" onClick={() => void open(x)}>
                      {c('download')}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      </QueryState>
      {confirming ? (
        <StepUpDialog
          title={t('confirmTitle')}
          description={t('confirmDescription')}
          onClose={() => setConfirming(false)}
          onVerified={() => {
            setConfirming(false);
            request.mutate(undefined);
          }}
        />
      ) : null}
    </>
  );
}
