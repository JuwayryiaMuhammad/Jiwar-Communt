'use client';

import { REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, ConfirmDialog, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-gl-periods';
import en from '@/messages/en/fin-gl-periods';

type Period = Schema<'GlPeriodView'>;

/**
 * Closing months (ADR 0092): a month is closed once it has ended, through
 * it and every open month before it; nothing is then dated in it, and an
 * event of it posts on the next open day. Reopening one is the manager's
 * alone, with a reason, on the record.
 */
export default function ClosingMonthsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const toast = useToast();
  const [closing, setClosing] = useState<Period | null>(null);
  const [reopening, setReopening] = useState<Period | null>(null);
  const periods = useQuery({ queryKey: keys.glPeriods, queryFn: fetchers.glPeriods, enabled: allowed });
  const close = useAction(
    (month: string) => unwrap(api.POST('/api/v1/staff/finance/gl/periods/close', { body: { month } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show(t('closeDone'));
        setClosing(null);
      },
    },
  );
  const reopen = useAction(
    ({ month, reasonCode }: { month: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/finance/gl/periods/reopen', { body: { month, reasonCode } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show(t('reopenDone'));
        setReopening(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <QueryState query={periods} rows={6}>
        <Card flush>
          <SectionHeader title={t('months')} description={t('monthsHint')} />
          <DataTable<Period>
            rows={periods.data?.data}
            rowKey={(p) => p.month}
            columns={[
              { key: 'm', header: t('month'), cell: (p) => f.month(p.month) },
              {
                key: 's',
                header: c('status'),
                cell: (p) => (p.status === 'closed' ? <Badge tone="dark">{label('closed')}</Badge> : <Badge tone="green">{label('open')}</Badge>),
              },
              {
                key: 'c',
                header: t('closed'),
                cell: (p) => (p.closedAt ? `${f.dateTime(p.closedAt)} · ${p.closedBy?.fullName ?? '—'}` : ''),
              },
              {
                key: 'r',
                header: t('reopened'),
                cell: (p) =>
                  p.reopenedAt ? `${f.dateTime(p.reopenedAt)} · ${p.reopenedBy?.fullName ?? '—'} · ${label(p.reopenReason)}` : '',
              },
              {
                key: 'a',
                header: '',
                cell: (p) =>
                  p.status === 'open' && p.ended && can('finance.ledger_write') ? (
                    <Button size="sm" onClick={() => setClosing(p)}>
                      {t('closeThrough')}
                    </Button>
                  ) : p.status === 'closed' && can('finance.ledger_reopen') ? (
                    <Button size="sm" variant="danger" onClick={() => setReopening(p)}>
                      {t('reopen')}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      </QueryState>
      <ConfirmDialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={t('closeTitle', { month: f.month(closing?.month) })}
        description={t('closeDescription')}
        confirmLabel={t('closeConfirm')}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={() => closing && close.mutate(closing.month)}
      />
      <ReasonCodeDialog
        open={reopening !== null}
        onClose={() => setReopening(null)}
        title={t('reopenTitle', { month: f.month(reopening?.month) })}
        description={t('reopenDescription')}
        codes={REASON_CODES.glPeriodReopen}
        confirmLabel={t('reopen')}
        danger
        pending={reopen.isPending}
        error={<ErrorAlert error={reopen.error} />}
        onConfirm={(reasonCode) => reopening && reopen.mutate({ month: reopening.month, reasonCode })}
      />
    </>
  );
}
