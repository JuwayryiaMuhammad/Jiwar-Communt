'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge, useCommonT, useLabel } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePersonName, useSlotText } from '@/components/management-requests/bits';
import { localName } from '@/components/management-requests/logic';
import { AppointmentActions } from '@/components/management-requests/request-appointment';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AppointmentFilters, type AppointmentItem, type AppointmentStatus } from '@/lib/queries';
import ar from '@/messages/ar/services-appointments';
import requestsAr from '@/messages/ar/services-mgmt-requests';
import en from '@/messages/en/services-appointments';
import requestsEn from '@/messages/en/services-mgmt-requests';

const VIEWS = ['upcoming', 'to_confirm', 'all'] as const;
type View = (typeof VIEWS)[number];
const STATUSES: AppointmentStatus[] = ['requested', 'proposed', 'confirmed', 'cancelled', 'superseded'];

/**
 * The compound's appointments with the management (ADR 0039), soonest
 * first. "To confirm" are the slots residents picked and nobody has
 * answered; a slot is confirmed, countered or cancelled from its row.
 */
export default function AppointmentsPage() {
  const t = useT(en, ar);
  const tr = useT(requestsEn, requestsAr);
  const c = useCommonT();
  const label = useLabel();
  const { locale } = useLocale();
  const personName = usePersonName();
  const slotText = useSlotText();
  const { can, ready } = usePermissions();
  const [view, setView] = useState<View>('upcoming');
  const [status, setStatus] = useState<AppointmentStatus | ''>('');
  // "From now" is fixed when the page opens, so paging does not shift under it.
  const [since] = useState(() => new Date().toISOString());
  const allowed = can('requests.handle');

  const filters: AppointmentFilters = {
    status: view === 'to_confirm' ? 'requested' : status,
    // An agenda shows what holds a slot, unless a status was asked for.
    live: view === 'upcoming' && !status ? 'true' : '',
    from: view === 'all' ? '' : since,
  };
  const list = useCursorList(keys.appointments(filters), (c) => fetchers.appointments(filters, c), {
    refetchInterval: 60_000,
    enabled: allowed,
  });

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
        <Field label={c('status')}>
          {(p) => (
            <Select
              {...p}
              value={view === 'to_confirm' ? 'requested' : status}
              disabled={view === 'to_confirm'}
              onChange={(e) => setStatus(e.target.value as AppointmentStatus | '')}
            >
              <option value="">{view === 'upcoming' ? t('holding') : t('anyStatus')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AppointmentItem>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={view === 'to_confirm' ? t('emptyToConfirm') : t('emptyAny')}
            emptyHint={view === 'upcoming' ? t('emptyHint') : undefined}
            columns={[
              {
                key: 'when',
                header: t('col.when'),
                cell: (a) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(a.startsAt, a.endsAt)}</span>,
              },
              { key: 'mode', header: t('col.how'), cell: (a) => tr(`mode.${a.mode}`) },
              {
                key: 'resident',
                header: t('col.resident'),
                cell: (a) => (
                  <span className="stack stack--sm">
                    {personName(a.request.author)}
                    {a.request.unit ? <span className="t-secondary">{tr('unitCode', { code: a.request.unit.code })}</span> : null}
                  </span>
                ),
              },
              {
                key: 'request',
                header: t('col.request'),
                cell: (a) => (
                  <span className="stack stack--sm">
                    <Link className="table__link t-mono" href={`/management-requests/${a.request.id}`}>
                      {a.request.number}
                    </Link>
                    <span className="t-secondary">{localName(locale, a.request.topic)}</span>
                  </span>
                ),
              },
              {
                key: 'status',
                header: c('status'),
                cell: (a) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={a.status} />
                    <span className="t-secondary">
                      {a.status === 'cancelled' ? label(a.cancelReason) : t(`pickedBy.${a.proposedBy}`)}
                    </span>
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (a) =>
                  a.status === 'requested' || a.status === 'proposed' || a.status === 'confirmed' ? (
                    <AppointmentActions requestId={a.request.id} number={a.request.number} requestStatus={a.request.status} appointment={a} compact />
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
