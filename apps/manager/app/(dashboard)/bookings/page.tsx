'use client';

import { QueryState } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Field, ForbiddenState, Input, PageHeader, Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { DayGrid } from '@/components/facilities/day-grid';
import { useLocalName } from '@/components/facilities/bits';
import { shiftDay } from '@/components/facilities/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fac-bookings';
import en from '@/messages/en/fac-bookings';

const today = () => new Date().toLocaleDateString('en-CA');

function BookingsView() {
  const t = useT(en, ar);
  const localName = useLocalName();
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
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <Field label={t('facility')}>
          {(p) => (
            <Select {...p} value={facilityId} onChange={(e) => go({ facility: e.target.value })}>
              {bookable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.active ? localName(f) : t('retiredName', { name: localName(f) })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <span className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Button iconOnly variant="text" aria-label={t('previousDay')} icon={<ChevronLeft aria-hidden className="icon-dir" />} onClick={() => go({ date: shiftDay(date, -1) })} />
          <Field label={t('day')}>{(p) => <Input {...p} type="date" value={date} onChange={(e) => e.target.value && go({ date: e.target.value })} />}</Field>
          <Button iconOnly variant="text" aria-label={t('nextDay')} icon={<ChevronRight aria-hidden className="icon-dir" />} onClick={() => go({ date: shiftDay(date, 1) })} />
          <Button onClick={() => go({ date: today() })}>{t('today')}</Button>
        </span>
      </div>
      {facilityId === '' ? (
        <QueryState query={facilities}>
          <p className="t-secondary">{t('noBookable')}</p>
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
