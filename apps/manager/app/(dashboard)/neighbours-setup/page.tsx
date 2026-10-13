'use client';

import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { ComplaintCategories } from '@/components/neighbours-setup/categories';
import { Limits } from '@/components/neighbours-setup/limits';
import { Welcome } from '@/components/neighbours-setup/welcome';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';

const TABS = ['categories', 'limits', 'welcome'] as const;
type Tab = (typeof TABS)[number];

function SetupView() {
  const [tab, setTab] = useTab(TABS, 'categories');
  const { ready, can } = usePermissions();
  // Every tab reads with `neighbours.manage`: without it there is nothing to show.
  if (ready && !can('neighbours.manage')) {
    return (
      <>
        <PageHeader title="Neighbours setup" />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Neighbours setup"
        description="What residents may complain about, how much one resident may have open on the boards, and what a household reads when it moves in."
      />
      <div className="toolbar" style={{ overflowX: 'auto' }}>
        <Segmented<Tab>
          label="Neighbours setup"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'categories', label: 'Categories' },
            { value: 'limits', label: 'Limits' },
            { value: 'welcome', label: 'Welcome' },
          ]}
        />
      </div>
      {tab === 'categories' ? <ComplaintCategories /> : tab === 'limits' ? <Limits /> : <Welcome />}
    </>
  );
}

export default function NeighboursSetupPage() {
  return (
    <Suspense>
      <SetupView />
    </Suspense>
  );
}
