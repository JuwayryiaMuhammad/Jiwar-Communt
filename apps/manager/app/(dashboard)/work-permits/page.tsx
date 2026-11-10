'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type WorkPermit } from '@/lib/queries';
import ar from '@/messages/ar/work-permits';
import en from '@/messages/en/work-permits';

const STATUSES = ['requested', 'approved', 'rejected', 'revoked', 'closed'] as const;

/** Technicians' work permits (ADR 0067): approved, rejected or revoked once. */
export default function WorkPermitsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const f = useFormat();
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
    done(t('approved')),
  );
  const reject = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/work-permits/{id}/reject', { params: { path: { id } }, body: { reasonCode } })),
    done(t('rejected'), () => setRejecting(null)),
  );
  const revoke = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/work-permits/{id}/revoke', { params: { path: { id } }, body: { reasonCode } })),
    done(t('revoked'), () => setRevoking(null)),
  );
  if (ready && !can('safety.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
          <option value="">{c('all')}</option>
        </Select>
      </div>
      <ErrorAlert error={approve.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<WorkPermit>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              { key: 'h', header: t('col.hazard'), cell: (p) => label(p.hazard) },
              { key: 't', header: t('col.ticket'), cell: (p) => <Link href={`/maintenance/${p.ticketId}`}>{t('openTicket')}</Link> },
              { key: 'p', header: t('col.precautions'), cell: (p) => p.precautions },
              { key: 'a', header: t('col.asked'), cell: (p) => f.dateTime(p.requestedAt) },
              { key: 'e', header: t('col.expires'), cell: (p) => f.dateTime(p.expiresAt) },
              { key: 's', header: t('col.status'), cell: (p) => label(p.status) },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (p) =>
                  p.status === 'requested' ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(p.id)}>
                        {c('approve')}
                      </Button>
                      <Button size="sm" onClick={() => setRejecting(p)}>
                        {c('reject')}
                      </Button>
                    </span>
                  ) : p.status === 'approved' ? (
                    <Button size="sm" onClick={() => setRevoking(p)}>
                      {t('revokeAction')}
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
        title={t('rejectTitle')}
        codes={REASON_CODES.workPermitReject}
        confirmLabel={c('reject')}
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(c) => rejecting && reject.mutate({ id: rejecting.id, reasonCode: c })}
      />
      <ReasonCodeDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('revokeTitle')}
        codes={REASON_CODES.workPermitRevoke}
        confirmLabel={t('revokeAction')}
        danger
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={(c) => revoking && revoke.mutate({ id: revoking.id, reasonCode: c })}
      />
    </>
  );
}
