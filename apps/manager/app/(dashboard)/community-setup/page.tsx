'use client';

import { useT } from '@jiwar/i18n';
import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { CommunityRules } from '@/components/community-setup/rules';
import { SuggestionTopics } from '@/components/community-setup/topics';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/community-setup';
import en from '@/messages/en/community-setup';

const TABS = ['topics', 'rules'] as const;
type Tab = (typeof TABS)[number];

function SetupView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'topics');
  const { ready, can } = usePermissions();
  // Topics are the suggestion handlers'; the event rules are the publishers'.
  const mayTopics = can('community.suggestions');
  const mayRules = can('community.publish');
  if (ready && !mayTopics && !mayRules) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const shown: Tab = tab === 'topics' && !mayTopics ? 'rules' : tab === 'rules' && !mayRules ? 'topics' : tab;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {mayTopics && mayRules ? (
        <div className="toolbar" style={{ overflowX: 'auto' }}>
          <Segmented<Tab> label={t('title')} value={shown} onChange={setTab} options={TABS.map((v) => ({ value: v, label: t(`tab.${v}`) }))} />
        </div>
      ) : null}
      {shown === 'topics' ? <SuggestionTopics /> : <CommunityRules />}
    </>
  );
}

export default function CommunitySetupPage() {
  return (
    <Suspense>
      <SetupView />
    </Suspense>
  );
}
