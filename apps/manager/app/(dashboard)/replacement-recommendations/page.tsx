'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, useCommonT, useLabel, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Replacement } from '@/lib/queries';
import ar from '@/messages/ar/replacement-recommendations';
import en from '@/messages/en/replacement-recommendations';

type Status = Replacement['status'] | '';

/** The technicians' recommendations to replace an asset (ADR 0064), decided once. */
export default function ReplacementsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('pending');
  const [declining, setDeclining] = useState<Replacement | null>(null);
  const filters = { status };
  const list = useCursorList(keys.replacements(filters), (c) => fetchers.replacements(filters, c), { enabled: can('assets.manage') });
  const accept = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/replacement-recommendations/{id}/accept', { params: { path: { id } } })),
    { invalidate: [keys.assetsAll], onDone: () => toast.show(t('accepted')) },
  );
  const decline = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/maintenance/replacement-recommendations/{id}/decline', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.assetsAll],
      onDone: () => {
        toast.show(t('declined'));
        setDeclining(null);
      },
    },
  );
  if (ready && !can('assets.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<Status>
          label={t('status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: t('status.pending') },
            { value: 'accepted', label: t('status.accepted') },
            { value: 'declined', label: t('status.declined') },
            { value: '', label: c('all') },
          ]}
        />
      </div>
      <ErrorAlert error={accept.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Replacement>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              {
                key: 'a',
                header: t('col.asset'),
                cell: (r) => (
                  <Link className="table__link" href={`/assets/${r.assetId}`}>
                    {c('open')}
                  </Link>
                ),
              },
              { key: 'w', header: t('col.why'), cell: (r) => label(r.reasonCode) },
              { key: 'n', header: t('col.note'), cell: (r) => r.note ?? '—' },
              { key: 't', header: t('col.when'), cell: (r) => f.dateTime(r.recommendedAt) },
              {
                key: 's',
                header: t('col.status'),
                cell: (r) =>
                  r.decisionReason
                    ? t('statusWithReason', { status: label(r.status), reason: label(r.decisionReason).toLowerCase() })
                    : label(r.status),
              },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (r) =>
                  r.status === 'pending' ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" variant="primary" loading={accept.isPending} onClick={() => accept.mutate(r.id)}>
                        {t('accept')}
                      </Button>
                      <Button size="sm" onClick={() => setDeclining(r)}>
                        {c('decline')}
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
        title={t('declineTitle')}
        codes={REASON_CODES.replacementDecline}
        confirmLabel={c('decline')}
        pending={decline.isPending}
        error={<ErrorAlert error={decline.error} />}
        onConfirm={(code) => declining && decline.mutate({ id: declining.id, reasonCode: code })}
      />
    </>
  );
}
