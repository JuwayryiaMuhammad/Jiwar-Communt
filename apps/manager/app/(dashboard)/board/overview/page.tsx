'use client';

import { fieldError } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SubjectCard } from '@/components/governance/board-ui';
import { columnLabel } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-inbox';
import en from '@/messages/en/gov-board-inbox';

/**
 * The board's overview (ADR 0055): read-only totals from the domains'
 * existing reports (the money, the budget, incidents and violations), for
 * up to 31 days; by default the last 30 days of the compound. No unit, no name.
 */
export default function BoardOverviewPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useQuery({ queryKey: keys.boardOverview(from, to), queryFn: () => fetchers.boardOverview(from, to), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('overviewTitle')} />
        <ForbiddenState />
      </>
    );
  const o = q.data;
  return (
    <>
      <PageHeader
        title={t('overviewTitle')}
        description={o ? t('range', { from: fmt.day(o.from), to: fmt.day(o.to) }) : t('overviewDescription')}
      />
      <div className="toolbar">
        <Field label={c('from')} error={fieldError(q.error, 'from')}>
          {(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
        <Field label={c('to')} error={fieldError(q.error, 'to')}>
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
      </div>
      <QueryState query={q}>
        {o ? (
          <div className="stack">
            {Object.entries(o.sections).map(([name, section]) => (
              <SubjectCard key={name} title={columnLabel(name, label)} subject={section} />
            ))}
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
