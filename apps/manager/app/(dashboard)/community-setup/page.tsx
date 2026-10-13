'use client';

import { ForbiddenState, PageHeader, Segmented } from '@jiwar/ui';
import { Suspense } from 'react';
import { CommunityRules } from '@/components/community-setup/rules';
import { SuggestionTopics } from '@/components/community-setup/topics';
import { usePermissions } from '@/lib/permissions';
import { useTab } from '@/lib/use-tab';

const TABS = ['topics', 'rules'] as const;
type Tab = (typeof TABS)[number];

function SetupView() {
  const [tab, setTab] = useTab(TABS, 'topics');
  const { ready, can } = usePermissions();
  // Topics are the suggestion handlers'; the event rules are the publishers'.
  const mayTopics = can('community.suggestions');
  const mayRules = can('community.publish');
  if (ready && !mayTopics && !mayRules) {
    return (
      <>
        <PageHeader title="Community setup" />
        <ForbiddenState />
      </>
    );
  }
  const shown: Tab = tab === 'topics' && !mayTopics ? 'rules' : tab === 'rules' && !mayRules ? 'topics' : tab;
  return (
    <>
      <PageHeader title="Community setup" description="What residents may send suggestions about, and how many guests an answer to an event may bring." />
      {mayTopics && mayRules ? (
        <div className="toolbar" style={{ overflowX: 'auto' }}>
          <Segmented<Tab>
            label="Community setup"
            value={shown}
            onChange={setTab}
            options={[
              { value: 'topics', label: 'Suggestion topics' },
              { value: 'rules', label: 'Event rules' },
            ]}
          />
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
