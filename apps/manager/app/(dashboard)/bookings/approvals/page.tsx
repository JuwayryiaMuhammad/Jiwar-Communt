'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { BookingActions } from '@/components/facilities/booking-actions';
import { useLocalName } from '@/components/facilities/bits';
import { usePersonName, useSlotText } from '@/components/management-requests/bits';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffBooking } from '@/lib/queries';
import ar from '@/messages/ar/fac-bookings';
import en from '@/messages/en/fac-bookings';

/**
 * Bookings waiting for the management's approval (ADR 0044), soonest
 * first. Each holds its place until it is approved, rejected, or its start
 * passes (then the system cancels it and tells the booker).
 */
export default function ApprovalsPage() {
  const t = useT(en, ar);
  const localName = useLocalName();
  const personName = usePersonName();
  const slotText = useSlotText();
  const { ready, can } = usePermissions();
  const allowed = can('bookings.handle');
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities, enabled: allowed });
  const names = new Map((facilities.data?.data ?? []).map((f) => [f.id, localName(f)]));
  const filters = { status: 'pending' as const };
  const list = useCursorList(keys.bookings(filters), (c) => fetchers.bookings(filters, c), {
    enabled: allowed,
    refetchInterval: 60_000,
  });
  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title={t('approvals.title')} description={t('approvals.description')} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffBooking>
            rows={list.rows}
            rowKey={(b) => b.id}
            empty={t('approvals.empty')}
            columns={[
              { key: 'when', header: t('col.when'), cell: (b) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(b.startsAt, b.endsAt)}</span> },
              {
                key: 'facility',
                header: t('col.facility'),
                cell: (b) => (
                  <Link className="table__link" href={`/bookings?facility=${b.facilityId}&date=${new Date(b.startsAt).toLocaleDateString('en-CA')}`}>
                    {names.get(b.facilityId) ?? t('approvals.facilityFallback')}
                  </Link>
                ),
              },
              {
                key: 'who',
                header: t('col.bookedBy'),
                cell: (b) => (
                  <span className="stack stack--sm">
                    {personName(b.bookedBy)}
                    <span className="t-secondary">
                      {t('unitCode', { code: b.unitCode })}
                      {b.guests ? ` · ${t('guests', { n: b.guests })}` : ''}
                    </span>
                  </span>
                ),
              },
              { key: 'actions', header: '', className: 'table__actions', cell: (b) => <BookingActions booking={b} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
