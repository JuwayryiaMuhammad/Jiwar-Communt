'use client';

import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { OfficeHours } from '@/components/management-setup/office-hours';
import { Ratings } from '@/components/management-setup/ratings';
import { Rules } from '@/components/management-setup/rules';
import { Topics } from '@/components/management-setup/topics';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';

const TABS = ['topics', 'hours', 'rules', 'ratings'] as const;
type Tab = (typeof TABS)[number];

function SetupView() {
  const [tab, setTab] = useTab(TABS, 'topics');
  const { ready, can } = usePermissions();
  // Every tab reads with `requests.manage`: without it there is nothing to show.
  if (ready && !can('requests.manage')) {
    return (
      <>
        <PageHeader title="Requests setup" />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Requests setup"
        description="What residents may write to the management about and how fast it answers, when the office takes appointments, and what residents said afterwards."
      />
      <div className="toolbar" style={{ overflowX: 'auto' }}>
        <Segmented<Tab>
          label="Requests setup"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'topics', label: 'Topics and targets' },
            { value: 'hours', label: 'Office hours' },
            { value: 'rules', label: 'Rules' },
            { value: 'ratings', label: 'Ratings' },
          ]}
        />
      </div>
      {tab === 'topics' ? <Topics /> : tab === 'hours' ? <OfficeHours /> : tab === 'rules' ? <Rules /> : <Ratings />}
    </>
  );
}

export default function ManagementSetupPage() {
  return (
    <Suspense>
      <SetupView />
    </Suspense>
  );
}
