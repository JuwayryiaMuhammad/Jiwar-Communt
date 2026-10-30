'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type WorkPermit } from '@/lib/queries';

const STATUSES = ['requested', 'approved', 'rejected', 'revoked', 'closed'] as const;

/** Technicians' work permits (ADR 0067): approved, rejected or revoked once. */
export default function WorkPermitsPage() {
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [status, setStatus] = useState<WorkPermit['status'] | ''>('requested');
  const [rejecting, setRejecting] = useState<WorkPermit | null>(null);
  const [revoking, setRevoking] = useState<WorkPermit | null>(null);
  const list = useCursorList(keys.workPermits({ status }), (c) => fetchers.workPermits({ status }, c), {
    enabled: can('safety.manage'),
  });
  const done = (text: string, after?: () => void) => ({
    invalidate: [['work-permits']],
    onDone: () => {
      toast.show(text);
      after?.();
    },
  });
  const approve = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/work-permits/{id}/approve', { params: { path: { id } } })),
    done('Approved; the technician is told.'),
  );
  const reject = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/work-permits/{id}/reject', { params: { path: { id } }, body: { reasonCode } })),
    done('Rejected; the technician is told.', () => setRejecting(null)),
  );
  const revoke = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/work-permits/{id}/revoke', { params: { path: { id } }, body: { reasonCode } })),
    done('Revoked; the technician is told to stop that work.', () => setRevoking(null)),
  );
  if (ready && !can('safety.manage'))
    return (
      <>
        <PageHeader title="Work permits" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Work permits"
        description="Hot work, height, live electrical, confined spaces and pool chemicals: the work starts only with a permit in force."
      />
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
          <option value="">All</option>
        </Select>
      </div>
      <ErrorAlert error={approve.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<WorkPermit>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="No permit"
            columns={[
              { key: 'h', header: 'Hazard', cell: (p) => humanize(p.hazard) },
              { key: 't', header: 'Ticket', cell: (p) => <Link href={`/maintenance/${p.ticketId}`}>Open the ticket</Link> },
              { key: 'p', header: 'Precautions', cell: (p) => p.precautions },
              { key: 'a', header: 'Asked', cell: (p) => formatDateTime(p.requestedAt) },
              { key: 'e', header: 'Expires', cell: (p) => formatDateTime(p.expiresAt) },
              { key: 's', header: 'Status', cell: (p) => humanize(p.status) },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (p) =>
                  p.status === 'requested' ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(p.id)}>
                        Approve
                      </Button>
                      <Button size="sm" onClick={() => setRejecting(p)}>
                        Reject
                      </Button>
                    </span>
                  ) : p.status === 'approved' ? (
                    <Button size="sm" onClick={() => setRevoking(p)}>
                      Revoke
                    </Button>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Reject the permit"
        codes={REASON_CODES.workPermitReject}
        confirmLabel="Reject"
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(c) => rejecting && reject.mutate({ id: rejecting.id, reasonCode: c })}
      />
      <ReasonCodeDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke the permit"
        codes={REASON_CODES.workPermitRevoke}
        confirmLabel="Revoke"
        danger
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={(c) => revoking && revoke.mutate({ id: revoking.id, reasonCode: c })}
      />
    </>
  );
}
