'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CompoundExport } from '@/lib/queries';

/**
 * The compound's export (ADR 0086): its operational data as one archive —
 * the register, the work and its costs, the stock, the common meters, the
 * budget and the capital plans — never a person's. After a fresh code,
 * once a day; ready for 7 days.
 */
export default function CompoundExportPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('compound.export');
  const list = useQuery({ queryKey: keys.compoundExports(), queryFn: fetchers.compoundExports, enabled: allowed, refetchInterval: 15_000 });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const request = useAction(() => unwrap(api.POST('/api/v1/staff/compound-exports', {})), {
    invalidate: [keys.compoundExports()],
    onDone: () => toast.show('Asked for. You are told in the app when it is ready.'),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Compound export" />
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
        title="Compound export"
        description="The compound’s operational data as one archive of fixed tables. No one’s name, phone, email or words; a person’s own data leaves only through their own export."
        actions={
          <Button variant="primary" loading={request.isPending} onClick={() => setConfirming(true)}>
            Export the compound
          </Button>
        }
      />
      <ErrorAlert error={request.error ?? error} />
      <QueryState query={list}>
        <Card flush>
          <DataTable<CompoundExport>
            rows={list.data?.data ?? []}
            rowKey={(x) => x.id}
            empty="No export yet"
            columns={[
              { key: 'asked', header: 'Asked', cell: (x) => new Date(x.requestedAt).toLocaleString('en-GB') },
              { key: 'status', header: 'Status', cell: (x) => <Badge tone={x.status === 'ready' ? 'green' : 'beige'}>{x.status}</Badge> },
              { key: 'rows', header: 'Rows', cell: (x) => x.rows ?? '—' },
              {
                key: 'file',
                header: '',
                cell: (x) =>
                  x.status === 'ready' ? (
                    <Button size="sm" onClick={() => void open(x)}>
                      Download
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      </QueryState>
      {confirming ? (
        <StepUpDialog
          title="Confirm it is you"
          description="The whole compound’s data leaves with this export: it is prepared only after a fresh code sent to your email."
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
