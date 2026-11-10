'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, DataTable, ReasonCodeDialog, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TicketDetail, type WorkPermit } from '@/lib/queries';
import ar from '@/messages/ar/maint-operations';
import en from '@/messages/en/maint-operations';

/**
 * A ticket's work permits (ADR 0067): the hazards its category and asset
 * type need one for, and this cycle's permits — decided here by who keeps
 * field safety. The work starts only with one in force for each hazard.
 */
export function TicketPermits({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
    { ...refresh, onDone: () => toast.show(t('permitApproved')) },
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
      <CardHeader title={t('permits')} />
      <CardBody>
        <ErrorAlert error={approve.error} />
        <QueryState query={permits}>
          {data ? (
            <>
              <p className="muted">
                {data.hazards.length
                  ? t('needsPermit', { hazards: fmt.list(data.hazards.map((h) => label(h))) })
                  : t('noPermitNeeded')}
              </p>
              <DataTable<WorkPermit>
                rows={data.permits}
                rowKey={(p) => p.id}
                empty={t('noPermit')}
                columns={[
                  { key: 'h', header: t('col.hazard'), cell: (p) => label(p.hazard) },
                  { key: 'p', header: t('col.precautions'), cell: (p) => p.precautions },
                  { key: 'e', header: t('col.expires'), cell: (p) => fmt.dateTime(p.expiresAt) },
                  { key: 's', header: t('col.status'), cell: (p) => label(p.status) },
                  {
                    key: 'x',
                    header: <span className="visually-hidden">{c('actions')}</span>,
                    className: 'table__actions',
                    cell: (p) =>
                      !decide ? null : p.status === 'requested' ? (
                        <span className="row" style={{ gap: 6 }}>
                          <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(p.id)}>
                            {t('approve')}
                          </Button>
                          <Button size="sm" onClick={() => setRejecting(p)}>
                            {t('reject')}
                          </Button>
                        </span>
                      ) : p.status === 'approved' ? (
                        <Button size="sm" onClick={() => setRevoking(p)}>
                          {t('revoke')}
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
        title={t('rejectTitle')}
        codes={REASON_CODES.workPermitReject}
        confirmLabel={t('reject')}
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => rejecting && reject.mutate({ id: rejecting.id, reasonCode: code })}
      />
      <ReasonCodeDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('revokeTitle')}
        codes={REASON_CODES.workPermitRevoke}
        confirmLabel={t('revoke')}
        danger
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={(code) => revoking && revoke.mutate({ id: revoking.id, reasonCode: code })}
      />
    </Card>
  );
}
