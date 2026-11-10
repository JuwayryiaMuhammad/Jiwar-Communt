'use client';

import { useT } from '@jiwar/i18n';
import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { AssetTypes } from '@/components/maintenance-setup/asset-types';
import { Categories } from '@/components/maintenance-setup/categories';
import { Checklists } from '@/components/maintenance-setup/checklists';
import { Dispatch } from '@/components/maintenance-setup/dispatch';
import { PreventiveServices } from '@/components/maintenance-setup/preventive';
import { Rules } from '@/components/maintenance-setup/rules';
import { Safety } from '@/components/maintenance-setup/safety';
import { ServicePressureCard } from '@/components/maintenance-setup/service-pressure';
import { Sla } from '@/components/maintenance-setup/sla';
import { Specialties } from '@/components/maintenance-setup/specialties';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/ms-page';
import en from '@/messages/en/ms-page';

const TABS = ['categories', 'specialties', 'preventive', 'rules', 'dispatch', 'sla', 'asset-types', 'checklists', 'safety'] as const;
type Tab = (typeof TABS)[number];

function SetupView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'categories');
  const { ready, can } = usePermissions();
  // Every tab reads with `maintenance.manage`: without it there is nothing to show.
  if (ready && !can('maintenance.manage')) {
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
          options={TABS.map((value) => ({ value, label: t(`tab.${value}`) }))}
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
        <div className="stack">
          <Dispatch />
          <ServicePressureCard />
        </div>
      ) : tab === 'asset-types' ? (
        <AssetTypes />
      ) : tab === 'checklists' ? (
        <Checklists />
      ) : tab === 'safety' ? (
        <Safety />
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
