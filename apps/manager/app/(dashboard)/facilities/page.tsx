'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, ButtonLink, Card, DataTable, ForbiddenState, PageHeader, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { FacilityBadges, HoursText, rulesText } from '@/components/facilities/bits';
import { NewFacilityDialog } from '@/components/facilities/new-facility-dialog';
import { NoShowRules } from '@/components/facilities/no-show-rules';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Facility } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['facilities', 'no-shows'] as const;
type Tab = (typeof TABS)[number];

function FacilitiesList({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities });
  const setActive = useAction(
    (f: Facility) => unwrap(api.PATCH('/api/v1/staff/facilities/{id}', { params: { path: { id: f.id } }, body: { active: !f.active } })),
    {
      invalidate: [keys.facilitiesAll],
      onDone: (f) => toast.show(f.active ? `${f.nameEn} is open to bookings again.` : `${f.nameEn} is retired. Bookings already made stay.`),
    },
  );

  return (
    <>
      {canManage ? (
        <div className="toolbar">
          <span className="spacer" />
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            New facility
          </Button>
        </div>
      ) : null}
      <ErrorAlert error={setActive.error} />
      <Card flush>
        <QueryState query={facilities}>
          <DataTable<Facility>
            rows={facilities.data?.data}
            rowKey={(f) => f.id}
            empty="No facility yet"
            emptyHint={canManage ? 'Create one: a court, the hall, the pool.' : undefined}
            columns={[
              {
                key: 'name',
                header: 'Facility',
                cell: (f) => (
                  <span className="stack stack--sm">
                    <Link className="table__link table__primary" href={`/facilities/${f.id}`}>
                      {f.nameEn}
                    </Link>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {f.nameAr}
                    </span>
                  </span>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (f) => <FacilityBadges facility={f} /> },
              { key: 'rules', header: 'Booking', cell: (f) => rulesText(f) },
              { key: 'hours', header: 'Hours', cell: (f) => <HoursText facility={f} /> },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (f) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    {f.mode === 'bookable' ? (
                      <ButtonLink size="sm" href={`/bookings?facility=${f.id}`}>
                        Day view
                      </ButtonLink>
                    ) : null}
                    {canManage ? (
                      <Button size="sm" loading={setActive.isPending && setActive.variables?.id === f.id} onClick={() => setActive.mutate(f)}>
                        {f.active ? 'Retire' : 'Restore'}
                      </Button>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {creating ? <NewFacilityDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function FacilitiesView() {
  const { ready, can } = usePermissions();
  const [tab, setTab] = useTab(TABS, 'facilities');
  const canManage = can('facilities.manage');
  if (ready && !canManage && !can('bookings.handle'))
    return (
      <>
        <PageHeader title="Facilities" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Facilities"
        description="The compound’s facilities: bookable ones by slot, with their rules, hours, peak times and closures; walk-in ones with their hours."
      />
      {canManage ? (
        <div className="toolbar">
          <Segmented<Tab>
            label="Facilities"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'facilities', label: 'Facilities' },
              { value: 'no-shows', label: 'No-show rules' },
            ]}
          />
        </div>
      ) : null}
      {tab === 'no-shows' && canManage ? <NoShowRules /> : <FacilitiesList canManage={canManage} />}
    </>
  );
}

export default function FacilitiesPage() {
  return (
    <Suspense>
      <FacilitiesView />
    </Suspense>
  );
}
