'use client';

import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { InspectionsPanel, ReportPanel, RoundsPanel } from '@/components/assets/inspection-panels';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';

const TABS = ['inspections', 'rounds', 'report'] as const;
type Tab = (typeof TABS)[number];

function InspectionsView() {
  const [tab, setTab] = useTab(TABS, 'inspections');
  const { ready, can } = usePermissions();
  if (ready && !can('inspections.manage'))
    return (
      <>
        <PageHeader title="Inspections" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Inspections"
        description="Walks of the compound's places with a checklist: what fails opens a work order, and what was done is reported."
      />
      <div className="toolbar">
        <Segmented<Tab>
          label="Inspections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'inspections', label: 'Inspections' },
            { value: 'rounds', label: 'Rounds' },
            { value: 'report', label: 'Report' },
          ]}
        />
      </div>
      {tab === 'inspections' ? <InspectionsPanel /> : tab === 'rounds' ? <RoundsPanel /> : <ReportPanel />}
    </>
  );
}

export default function InspectionsPage() {
  return (
    <Suspense>
      <InspectionsView />
    </Suspense>
  );
}
