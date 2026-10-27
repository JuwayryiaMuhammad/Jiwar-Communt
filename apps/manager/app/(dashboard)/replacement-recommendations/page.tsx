'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Replacement } from '@/lib/queries';

type Status = Replacement['status'] | '';

/** The technicians' recommendations to replace an asset (ADR 0064), decided once. */
export default function ReplacementsPage() {
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('pending');
  const [declining, setDeclining] = useState<Replacement | null>(null);
  const filters = { status };
  const list = useCursorList(keys.replacements(filters), (c) => fetchers.replacements(filters, c), { enabled: can('assets.manage') });
  const accept = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/replacement-recommendations/{id}/accept', { params: { path: { id } } })),
    { invalidate: [keys.assetsAll], onDone: () => toast.show('Accepted.') },
  );
  const decline = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/replacement-recommendations/{id}/decline', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.assetsAll],
      onDone: () => {
        toast.show('Declined.');
        setDeclining(null);
      },
    },
  );
  if (ready && !can('assets.manage'))
    return (
      <>
        <PageHeader title="Replacements" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Replacements" description="What the technicians recommend replacing, and why." />
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'To decide' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'declined', label: 'Declined' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <ErrorAlert error={accept.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Replacement>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="Nothing to decide"
            columns={[
              {
                key: 'a',
                header: 'Asset',
                cell: (r) => (
                  <Link className="table__link" href={`/assets/${r.assetId}`}>
                    Open
                  </Link>
                ),
              },
              { key: 'w', header: 'Why', cell: (r) => humanize(r.reasonCode) },
              { key: 'n', header: 'Note', cell: (r) => r.note ?? '—' },
              { key: 't', header: 'When', cell: (r) => formatDateTime(r.recommendedAt) },
              { key: 's', header: 'Status', cell: (r) => humanize(r.status) + (r.decisionReason ? ` (${humanize(r.decisionReason).toLowerCase()})` : '') },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (r) =>
                  r.status === 'pending' ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" variant="primary" loading={accept.isPending} onClick={() => accept.mutate(r.id)}>
                        Accept
                      </Button>
                      <Button size="sm" onClick={() => setDeclining(r)}>
                        Decline
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={declining !== null}
        onClose={() => setDeclining(null)}
        title="Decline the recommendation"
        codes={REASON_CODES.replacementDecline}
        confirmLabel="Decline"
        pending={decline.isPending}
        error={<ErrorAlert error={decline.error} />}
        onConfirm={(c) => declining && decline.mutate({ id: declining.id, reasonCode: c })}
      />
    </>
  );
}
