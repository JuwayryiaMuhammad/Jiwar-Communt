'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { BookingActions } from '@/components/facilities/booking-actions';
import { personName, slotText } from '@/components/management-requests/bits';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffBooking } from '@/lib/queries';

/**
 * Bookings waiting for the management's approval (ADR 0044), soonest
 * first. Each holds its place until it is approved, rejected, or its start
 * passes (then the system cancels it and tells the booker).
 */
export default function ApprovalsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('bookings.handle');
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities, enabled: allowed });
  const names = new Map((facilities.data?.data ?? []).map((f) => [f.id, f.nameEn]));
  const filters = { status: 'pending' as const };
  const list = useCursorList(keys.bookings(filters), (c) => fetchers.bookings(filters, c), {
    enabled: allowed,
    refetchInterval: 60_000,
  });
  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title="Approvals" description="Bookings of facilities that require approval, waiting for a decision. Approving never goes past the slot’s capacity." />
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffBooking>
            rows={list.rows}
            rowKey={(b) => b.id}
            empty="Nothing waits for approval"
            columns={[
              { key: 'when', header: 'When', cell: (b) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(b.startsAt, b.endsAt)}</span> },
              {
                key: 'facility',
                header: 'Facility',
                cell: (b) => (
                  <Link className="table__link" href={`/bookings?facility=${b.facilityId}&date=${new Date(b.startsAt).toLocaleDateString('en-CA')}`}>
                    {names.get(b.facilityId) ?? 'Facility'}
                  </Link>
                ),
              },
              {
                key: 'who',
                header: 'Booked by',
                cell: (b) => (
                  <span className="stack stack--sm">
                    {personName(b.bookedBy)}
                    <span className="t-secondary">
                      Unit {b.unitCode}
                      {b.guests ? ` · +${b.guests} guest${b.guests === 1 ? '' : 's'}` : ''}
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
