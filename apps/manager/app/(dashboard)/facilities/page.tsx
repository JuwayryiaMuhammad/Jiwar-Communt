'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, ButtonLink, Card, DataTable, ForbiddenState, PageHeader, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { FacilityBadges, HoursText, rulesText, useLocalName } from '@/components/facilities/bits';
import { NewFacilityDialog } from '@/components/facilities/new-facility-dialog';
import { NoShowRules } from '@/components/facilities/no-show-rules';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Facility } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';

const TABS = ['facilities', 'no-shows'] as const;
type Tab = (typeof TABS)[number];

function FacilitiesList({ canManage }: { canManage: boolean }) {
  const t = useT(en, ar);
  const name = useLocalName();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const facilities = useQuery({ queryKey: keys.facilities, queryFn: fetchers.facilities });
  const setActive = useAction(
    (f: Facility) => unwrap(api.PATCH('/api/v1/staff/facilities/{id}', { params: { path: { id: f.id } }, body: { active: !f.active } })),
    {
      invalidate: [keys.facilitiesAll],
      onDone: (f) => toast.show(f.active ? t('reopened', { name: name(f) }) : t('retiredToast', { name: name(f) })),
    },
  );

  return (
    <>
      {canManage ? (
        <div className="toolbar">
          <span className="spacer" />
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            {t('newFacility')}
          </Button>
        </div>
      ) : null}
      <ErrorAlert error={setActive.error} />
      <Card flush>
        <QueryState query={facilities}>
          <DataTable<Facility>
            rows={facilities.data?.data}
            rowKey={(f) => f.id}
            empty={t('empty')}
            emptyHint={canManage ? t('emptyHint') : undefined}
            columns={[
              {
                key: 'name',
                header: t('col.facility'),
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
              { key: 'kind', header: t('col.kind'), cell: (f) => <FacilityBadges facility={f} /> },
              { key: 'rules', header: t('col.booking'), cell: (f) => rulesText(f, t) },
              { key: 'hours', header: t('col.hours'), cell: (f) => <HoursText facility={f} /> },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (f) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    {f.mode === 'bookable' ? (
                      <ButtonLink size="sm" href={`/bookings?facility=${f.id}`}>
                        {t('dayView')}
                      </ButtonLink>
                    ) : null}
                    {canManage ? (
                      <Button size="sm" loading={setActive.isPending && setActive.variables?.id === f.id} onClick={() => setActive.mutate(f)}>
                        {f.active ? t('retire') : t('restore')}
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
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const [tab, setTab] = useTab(TABS, 'facilities');
  const canManage = can('facilities.manage');
  if (ready && !canManage && !can('bookings.handle'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {canManage ? (
        <div className="toolbar">
          <Segmented<Tab>
            label={t('title')}
            value={tab}
            onChange={setTab}
            options={TABS.map((v) => ({ value: v, label: t(`tab.${v}`) }))}
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
