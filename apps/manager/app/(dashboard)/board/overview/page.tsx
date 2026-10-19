'use client';

import { fieldError } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SubjectCard } from '@/components/governance/board-ui';
import { columnLabel } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/**
 * The board's overview (ADR 0055): read-only totals from the domains'
 * existing reports (the money, the budget, incidents and violations), for
 * up to 31 days; by default the last 30 days of the compound. No unit, no name.
 */
export default function BoardOverviewPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useQuery({ queryKey: keys.boardOverview(from, to), queryFn: () => fetchers.boardOverview(from, to), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Overview" />
        <ForbiddenState />
      </>
    );
  const o = q.data;
  return (
    <>
      <PageHeader title="Overview" description={o ? `${o.from} – ${o.to}` : 'The compound at a glance, for the board.'} />
      <div className="toolbar">
        <Field label="From" error={fieldError(q.error, 'from')}>
          {(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
        <Field label="To" error={fieldError(q.error, 'to')}>
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
      </div>
      <QueryState query={q}>
        {o ? (
          <div className="stack">
            {Object.entries(o.sections).map(([name, section]) => (
              <SubjectCard key={name} title={columnLabel(name)} subject={section} />
            ))}
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
