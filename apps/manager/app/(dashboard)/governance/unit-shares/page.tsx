'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys, shareProblem, type UnitShares } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';

type Row = UnitShares['items'][number];

/**
 * The units' ownership shares (ADR 0075): what a poll weighted by share
 * counts each unit by, taken when its voting opens. A unit with none
 * weighs 0. The shares need not add up to 100.
 */
export default function UnitSharesPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const q = useQuery({ queryKey: boardWorkKeys.shares, queryFn: boardWorkFetchers.shares, enabled: allowed });
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(q.data.items.map((i) => [i.unitId, i.share ?? ''])));
  }, [q.data]);
  const changed = (q.data?.items ?? []).filter((i) => (draft[i.unitId] ?? '').trim() !== (i.share ?? ''));
  const problems = changed.map((i) => shareProblem(draft[i.unitId] ?? '')).filter(Boolean);
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/staff/governance/unit-shares', {
          body: { shares: changed.map((i) => ({ unitId: i.unitId, share: (draft[i.unitId] ?? '').trim() || null })) },
        }),
      ),
    { invalidate: [boardWorkKeys.shares], onDone: () => toast.show('Saved. A poll already open keeps the shares it took.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Ownership shares" />
        <ForbiddenState />
      </>
    );
  const index = (unitId: string) => changed.findIndex((i) => i.unitId === unitId);
  return (
    <>
      <PageHeader
        title="Ownership shares"
        description={
          q.data
            ? `For polls weighted by share. Recorded: ${q.data.total}% in all; ${q.data.missing} owned unit(s) have none and weigh 0.`
            : 'For polls weighted by share.'
        }
        actions={
          <Button variant="primary" loading={save.isPending} disabled={!changed.length || problems.length > 0} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        }
      />
      <Card flush>
        <QueryState query={q}>
          <DataTable<Row>
            rows={q.data?.items ?? []}
            rowKey={(i) => i.unitId}
            empty="No owned unit yet"
            columns={[
              { key: 'u', header: 'Unit', cell: (i) => i.unitCode },
              {
                key: 's',
                header: 'Share (%)',
                cell: (i) => (
                  <>
                    <Input
                      aria-label={`Share of ${i.unitCode}`}
                      inputMode="decimal"
                      placeholder="None"
                      value={draft[i.unitId] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [i.unitId]: e.target.value }))}
                    />
                    <span className="t-error">
                      {shareProblem(draft[i.unitId] ?? '') ?? fieldError(save.error, `shares.${index(i.unitId)}.share`)}
                    </span>
                  </>
                ),
              },
            ]}
          />
          <ErrorAlert error={save.error} />
        </QueryState>
      </Card>
    </>
  );
}
