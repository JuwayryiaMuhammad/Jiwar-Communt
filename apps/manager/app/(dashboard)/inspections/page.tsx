'use client';

import { useT } from '@jiwar/i18n';
import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { InspectionsPanel, ReportPanel, RoundsPanel } from '@/components/assets/inspection-panels';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/assets-inspections';
import en from '@/messages/en/assets-inspections';

const TABS = ['inspections', 'rounds', 'report'] as const;
type Tab = (typeof TABS)[number];

function InspectionsView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'inspections');
  const { ready, can } = usePermissions();
  if (ready && !can('inspections.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<Tab> label={t('title')} value={tab} onChange={setTab} options={TABS.map((v) => ({ value: v, label: t(`tab.${v}`) }))} />
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
