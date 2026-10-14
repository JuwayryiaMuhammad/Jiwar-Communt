'use client';

import { QueryState } from '@jiwar/api/react';
import { Button, Field, ForbiddenState, Input, PageHeader, Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { DayGrid } from '@/components/facilities/day-grid';
import { shiftDay } from '@/components/facilities/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');

function BookingsView() {
  const { ready, can } = usePermissions();
  const allowed = can('bookings.handle');
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities, enabled: allowed });
  const bookable = (facilities.data?.data ?? []).filter((f) => f.mode === 'bookable');
  const facilityId = params.get('facility') ?? bookable[0]?.id ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : today();
  const go = (next: { facility?: string; date?: string }) => {
    const q = new URLSearchParams({ facility: next.facility ?? facilityId, date: next.date ?? date });
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };
  const day = useQuery({
    queryKey: keys.facilityDay(facilityId, date),
    queryFn: () => fetchers.facilityDay(facilityId, date),
    enabled: allowed && facilityId !== '',
    refetchInterval: 60_000,
  });

  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Bookings" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Bookings"
        description="A facility’s day: each slot, how full it is, and who booked it. Approve, reject, cancel, or mark a no-show from the booking."
      />
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <Field label="Facility">
          {(p) => (
            <Select {...p} value={facilityId} onChange={(e) => go({ facility: e.target.value })}>
              {bookable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.nameEn}
                  {f.active ? '' : ' (retired)'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <span className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Button iconOnly variant="text" aria-label="Previous day" icon={<ChevronLeft aria-hidden />} onClick={() => go({ date: shiftDay(date, -1) })} />
          <Field label="Day">{(p) => <Input {...p} type="date" value={date} onChange={(e) => e.target.value && go({ date: e.target.value })} />}</Field>
          <Button iconOnly variant="text" aria-label="Next day" icon={<ChevronRight aria-hidden />} onClick={() => go({ date: shiftDay(date, 1) })} />
          <Button onClick={() => go({ date: today() })}>Today</Button>
        </span>
      </div>
      {facilityId === '' ? (
        <QueryState query={facilities}>
          <p className="t-secondary">No bookable facility yet.</p>
        </QueryState>
      ) : (
        <QueryState query={day}>{day.data ? <DayGrid day={day.data} /> : null}</QueryState>
      )}
    </>
  );
}

export default function BookingsPage() {
  return (
    <Suspense>
      <BookingsView />
    </Suspense>
  );
}
