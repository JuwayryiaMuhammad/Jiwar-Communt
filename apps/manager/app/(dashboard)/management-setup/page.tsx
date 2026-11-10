'use client';

import { useT } from '@jiwar/i18n';
import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { OfficeHours } from '@/components/management-setup/office-hours';
import { Ratings } from '@/components/management-setup/ratings';
import { Rules } from '@/components/management-setup/rules';
import { Topics } from '@/components/management-setup/topics';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/services-mgmt-setup';
import en from '@/messages/en/services-mgmt-setup';

const TABS = ['topics', 'hours', 'rules', 'ratings'] as const;
type Tab = (typeof TABS)[number];

function SetupView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'topics');
  const { ready, can } = usePermissions();
  // Every tab reads with `requests.manage`: without it there is nothing to show.
  if (ready && !can('requests.manage')) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="toolbar" style={{ overflowX: 'auto' }}>
        <Segmented<Tab>
          label={t('title')}
          value={tab}
          onChange={setTab}
          options={TABS.map((v) => ({ value: v, label: t(`tab.${v}`) }))}
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
