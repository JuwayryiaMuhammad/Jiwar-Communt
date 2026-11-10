'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BookingSuspension } from '@/lib/queries';
import ar from '@/messages/ar/fac-bookings';
import en from '@/messages/en/fac-bookings';

/**
 * Units suspended from booking after no-shows (ADR 0044). While a
 * suspension is in force the unit makes no new booking; what it holds
 * stays. A handler may lift one, with a reason code.
 */
export default function BookingSuspensionsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('bookings.handle');
  const [inForce, setInForce] = useState<'true' | 'false'>('true');
  const [lifting, setLifting] = useState<BookingSuspension | null>(null);
  const list = useCursorList(keys.suspensions(inForce), (c) => fetchers.suspensions(inForce, c), { enabled: allowed });
  const lift = useAction(
    (input: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/booking-suspensions/{id}/lift', { params: { path: { id: input.id } }, body: { reasonCode: input.reasonCode } })),
    {
      invalidate: [keys.suspensionsAll],
      onDone: () => {
        toast.show(t('lifted'));
        setLifting(null);
      },
    },
  );
  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title={t('suspensions.title')} description={t('suspensions.description')} />
      <div className="toolbar">
        <Segmented<'true' | 'false'>
          label={t('suspensions.shown')}
          value={inForce}
          onChange={setInForce}
          options={[
            { value: 'true', label: t('suspensions.inForce') },
            { value: 'false', label: c('all') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<BookingSuspension>
            rows={list.rows}
            rowKey={(s) => s.id}
            empty={inForce === 'true' ? t('suspensions.emptyInForce') : t('suspensions.empty')}
            columns={[
              { key: 'unit', header: c('unit'), cell: (s) => <span className="t-mono">{s.unitCode}</span> },
              { key: 'since', header: t('col.since'), cell: (s) => f.dateTime(s.startsAt) },
              { key: 'until', header: t('col.until'), cell: (s) => f.dateTime(s.endsAt) },
              { key: 'count', header: t('col.noShows'), cell: (s) => s.noShowCount },
              {
                key: 'state',
                header: c('status'),
                cell: (s) =>
                  s.liftedAt ? (
                    <Badge tone="beige">{t('state.lifted', { reason: label(s.liftReasonCode) })}</Badge>
                  ) : new Date(s.endsAt) <= new Date() ? (
                    <Badge tone="beige">{t('state.over')}</Badge>
                  ) : (
                    <Badge tone="error">{t('state.inForce')}</Badge>
                  ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (s) =>
                  !s.liftedAt && new Date(s.endsAt) > new Date() ? (
                    <Button size="sm" onClick={() => setLifting(s)}>
                      {t('lift')}
                    </Button>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={lifting !== null}
        onClose={() => setLifting(null)}
        title={t('liftTitle', { unit: lifting?.unitCode ?? '' })}
        description={t('liftDescription')}
        codes={REASON_CODES.bookingSuspensionLift}
        confirmLabel={t('lift')}
        pending={lift.isPending}
        error={<ErrorAlert error={lift.error} />}
        onConfirm={(reasonCode) => lifting && lift.mutate({ id: lifting.id, reasonCode })}
      />
    </>
  );
}
