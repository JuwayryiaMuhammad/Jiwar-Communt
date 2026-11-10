'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { personNameIn, postNameIn } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GuardSwap, type GuardSwapStatus } from '@/lib/queries';
import ar from '@/messages/ar/sec-swaps';
import en from '@/messages/en/sec-swaps';

const VIEWS = ['accepted', 'requested', 'approved', 'all'] as const;
type View = (typeof VIEWS)[number];

/**
 * Shift swaps (ADR 0050): a guard asks a colleague to take a slot, the
 * colleague accepts, and they are decided here. Approval checks again
 * that nothing changed and nobody is left with overlapping slots.
 */
export default function SwapsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const { ready, can, me } = usePermissions();
  const allowed = can('guard_roster.manage');
  const [view, setView] = useState<View>('accepted');
  const [rejecting, setRejecting] = useState<GuardSwap | null>(null);
  const status: GuardSwapStatus | '' = view === 'all' ? '' : view;
  const list = useCursorList(keys.swaps(status), (cursor) => fetchers.swaps(status, cursor), { enabled: allowed });
  const approve = useAction(
    (s: GuardSwap) => unwrap(api.POST('/api/v1/staff/security/swaps/{id}/approve', { params: { path: { id: s.id } } })),
    { invalidate: [keys.swapsAll, keys.rosterAll], onDone: () => toast.show(t('approved')) },
  );
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/security/swaps/{id}/reject', {
          params: { path: { id: rejecting!.id } },
          body: { reasonCode: reasonCode as (typeof REASON_CODES.guardSwapReject)[number] },
        }),
      ),
    {
      invalidate: [keys.swapsAll],
      onDone: () => {
        toast.show(t('rejected'));
        setRejecting(null);
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
  const mine = (s: GuardSwap) => s.requester.id === me?.id || s.colleague.id === me?.id;
  const slotText = (s: GuardSwap['requesterSlot'] | null) =>
    s ? `${postNameIn(s.post, locale)} · ${f.dateTime(s.startsAt)}` : t('cover');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={[
            { value: 'accepted', label: t('view.accepted') },
            { value: 'requested', label: t('view.requested') },
            { value: 'approved', label: t('view.approved') },
            { value: 'all', label: c('all') },
          ]}
        />
      </div>
      <ErrorAlert error={approve.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<GuardSwap>
            rows={list.rows}
            rowKey={(s) => s.id}
            empty={view === 'accepted' ? t('emptyToDecide') : t('empty')}
            columns={[
              { key: 'from', header: t('col.askedBy'), cell: (s) => personNameIn(s.requester, locale) },
              { key: 'slot', header: t('col.slot'), cell: (s) => slotText(s.requesterSlot) },
              { key: 'to', header: t('col.colleague'), cell: (s) => personNameIn(s.colleague, locale) },
              { key: 'back', header: t('col.exchange'), cell: (s) => slotText(s.colleagueSlot) },
              { key: 'reason', header: t('col.reason'), cell: (s) => s.reason ?? '—' },
              {
                key: 'status',
                header: c('status'),
                cell: (s) => (
                  <span className="row">
                    <StatusBadge status={s.status} />
                    {s.rejectReason || s.closeReason ? <span className="t-secondary">{label(s.rejectReason ?? s.closeReason)}</span> : null}
                  </span>
                ),
              },
              { key: 'when', header: t('col.asked'), cell: (s) => <span title={f.dateTime(s.createdAt)}>{f.relative(s.createdAt)}</span> },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (s) =>
                  s.status === 'accepted' && !mine(s) ? (
                    <span className="row" style={{ justifyContent: 'flex-end' }}>
                      <Button size="sm" variant="primary" loading={approve.isPending && approve.variables?.id === s.id} onClick={() => approve.mutate(s)}>
                        {t('approve')}
                      </Button>
                      <Button size="sm" onClick={() => setRejecting(s)}>
                        {t('reject')}
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
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={t('rejectTitle')}
        description={t('rejectDescription')}
        codes={REASON_CODES.guardSwapReject}
        confirmLabel={t('reject')}
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(reasonCode) => reject.mutate(reasonCode)}
      />
    </>
  );
}
