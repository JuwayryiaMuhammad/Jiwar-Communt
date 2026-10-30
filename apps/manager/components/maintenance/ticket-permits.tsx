'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, DataTable, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TicketDetail, type WorkPermit } from '@/lib/queries';

/**
 * A ticket's work permits (ADR 0067): the hazards its category and asset
 * type need one for, and this cycle's permits — decided here by who keeps
 * field safety. The work starts only with one in force for each hazard.
 */
export function TicketPermits({ ticket }: { ticket: TicketDetail }) {
  const { can } = usePermissions();
  const toast = useToast();
  const decide = can('safety.manage');
  const shown = decide || can('tickets.dispatch');
  const permits = useQuery({
    queryKey: keys.ticketPermits(ticket.id),
    queryFn: () => fetchers.ticketPermits(ticket.id),
    enabled: shown,
  });
  const [rejecting, setRejecting] = useState<WorkPermit | null>(null);
  const [revoking, setRevoking] = useState<WorkPermit | null>(null);
  const refresh = { invalidate: [keys.ticketPermits(ticket.id), ['work-permits']] };
  const approve = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/work-permits/{id}/approve', { params: { path: { id } } })),
    { ...refresh, onDone: () => toast.show('Approved; the technician is told.') },
  );
  const reject = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/work-permits/{id}/reject', { params: { path: { id } }, body: { reasonCode } })),
    { ...refresh, onDone: () => setRejecting(null) },
  );
  const revoke = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/work-permits/{id}/revoke', { params: { path: { id } }, body: { reasonCode } })),
    { ...refresh, onDone: () => setRevoking(null) },
  );
  if (!shown) return null;
  const data = permits.data;
  if (data && !data.hazards.length && !data.permits.length) return null;
  return (
    <Card flush>
      <CardHeader title="Work permits" />
      <CardBody>
        <ErrorAlert error={approve.error} />
        <QueryState query={permits}>
          {data ? (
            <>
              <p className="muted">
                {data.hazards.length
                  ? `Needs a permit for: ${data.hazards.map(humanize).join(', ')}.`
                  : 'Its work needs no permit.'}
              </p>
              <DataTable<WorkPermit>
                rows={data.permits}
                rowKey={(p) => p.id}
                empty="None asked for in this cycle"
                columns={[
                  { key: 'h', header: 'Hazard', cell: (p) => humanize(p.hazard) },
                  { key: 'p', header: 'Precautions', cell: (p) => p.precautions },
                  { key: 'e', header: 'Expires', cell: (p) => formatDateTime(p.expiresAt) },
                  { key: 's', header: 'Status', cell: (p) => humanize(p.status) },
                  {
                    key: 'x',
                    header: <span className="visually-hidden">Actions</span>,
                    className: 'table__actions',
                    cell: (p) =>
                      !decide ? null : p.status === 'requested' ? (
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
            </>
          ) : null}
        </QueryState>
      </CardBody>
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
    </Card>
  );
}
