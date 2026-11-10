'use client';

import { useT } from '@jiwar/i18n';
import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { ComplaintCategories } from '@/components/neighbours-setup/categories';
import { Limits } from '@/components/neighbours-setup/limits';
import { Welcome } from '@/components/neighbours-setup/welcome';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/neighbours-setup';
import en from '@/messages/en/neighbours-setup';

const TABS = ['categories', 'limits', 'welcome'] as const;
type Tab = (typeof TABS)[number];

function SetupView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'categories');
  const { ready, can } = usePermissions();
  // Every tab reads with `neighbours.manage`: without it there is nothing to show.
  if (ready && !can('neighbours.manage')) {
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
          options={[
            { value: 'categories', label: t('tab.categories') },
            { value: 'limits', label: t('tab.limits') },
            { value: 'welcome', label: t('tab.welcome') },
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
