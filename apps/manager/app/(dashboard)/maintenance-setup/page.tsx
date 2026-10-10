'use client';

import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { Categories } from '@/components/maintenance-setup/categories';
import { Dispatch } from '@/components/maintenance-setup/dispatch';
import { PreventiveServices } from '@/components/maintenance-setup/preventive';
import { Rules } from '@/components/maintenance-setup/rules';
import { Sla } from '@/components/maintenance-setup/sla';
import { Specialties } from '@/components/maintenance-setup/specialties';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';

const TABS = ['categories', 'specialties', 'preventive', 'rules', 'dispatch', 'sla'] as const;
type Tab = (typeof TABS)[number];

function SetupView() {
  const [tab, setTab] = useTab(TABS, 'categories');
  const { ready, can } = usePermissions();
  // Every tab reads with `maintenance.manage`: without it there is nothing to show.
  if (ready && !can('maintenance.manage')) {
    return (
      <>
        <PageHeader title="Maintenance setup" />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Maintenance setup"
        description="What residents can report and book, who can fix it, when visits happen, and how tickets are assigned and timed."
      />
      <div className="toolbar" style={{ overflowX: 'auto' }}>
        <Segmented<Tab>
          label="Maintenance setup"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'categories', label: 'Categories' },
            { value: 'specialties', label: 'Specialties' },
            { value: 'preventive', label: 'Preventive services' },
            { value: 'rules', label: 'Hours and limits' },
            { value: 'dispatch', label: 'Dispatch' },
            { value: 'sla', label: 'SLA' },
          ]}
        />
      </div>
      {tab === 'categories' ? (
        <Categories view="categories" />
      ) : tab === 'specialties' ? (
        <Specialties />
      ) : tab === 'preventive' ? (
        <PreventiveServices />
      ) : tab === 'rules' ? (
        <Rules />
      ) : tab === 'dispatch' ? (
        <Dispatch />
      ) : (
        <Sla />
      )}
    </>
  );
}

export default function MaintenanceSetupPage() {
  return (
    <Suspense>
      <SetupView />
    </Suspense>
  );
}
