'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { APPROVAL_TYPE_TEXT } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GovernanceSetting } from '@/lib/queries';

type Draft = Record<string, { deadlineDays: string; threshold: string }>;

const TYPE_TEXT: Record<string, string> = { ...APPROVAL_TYPE_TEXT, board_appeal: 'Appeal to the board' };
const THRESHOLD_HINT: Record<string, string> = {
  major_contract: 'The manager’s limit: an expense above it needs a contract the board approved.',
};

/** How long the board has for each kind of matter, and the thresholds (ADR 0055). */
export default function GovernanceSettingsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const q = useQuery({ queryKey: keys.governanceSettings, queryFn: fetchers.governanceSettings, enabled: allowed });
  const [draft, setDraft] = useState<Draft>({});
  useEffect(() => {
    if (q.data)
      setDraft(
        Object.fromEntries(q.data.items.map((i) => [i.type, { deadlineDays: String(i.deadlineDays), threshold: i.threshold ?? '' }])),
      );
  }, [q.data]);
  /** A setting's draft; one the list has not loaded yet is empty. */
  const at = (type: string) => draft[type] ?? { deadlineDays: '', threshold: '' };
  const changed = (q.data?.items ?? []).filter((i) => {
    const d = draft[i.type];
    return d && (d.deadlineDays !== String(i.deadlineDays) || (i.thresholded && d.threshold.trim() !== (i.threshold ?? '')));
  });
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/governance/settings', {
          body: {
            items: changed.map((i) => ({
              type: i.type,
              deadlineDays: Number(at(i.type).deadlineDays),
              ...(i.thresholded ? { threshold: at(i.type).threshold.trim() || null } : {}),
            })),
          },
        }),
      ),
    { invalidate: [keys.governanceSettings], onDone: () => toast.show('Saved. Matters already raised keep their deadlines.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Board settings" />
        <ForbiddenState />
      </>
    );
  const set = (type: string, field: 'deadlineDays' | 'threshold', value: string) =>
    setDraft((d) => ({ ...d, [type]: { ...(d[type] ?? { deadlineDays: '', threshold: '' }), [field]: value } }));
  // The errors name the items as sent: the changed ones, in order.
  const index = (type: string) => changed.findIndex((i) => i.type === type);
  return (
    <>
      <PageHeader
        title="Board settings"
        description="Days the board has to decide each kind of matter; past them, the board and the management are told once. Thresholds are shown to the board with each request; only the major contract’s binds."
        actions={
          <Button variant="primary" loading={save.isPending} disabled={!changed.length} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        }
      />
      <Card flush>
        <QueryState query={q}>
          <DataTable<GovernanceSetting>
            rows={q.data?.items ?? []}
            rowKey={(i) => i.type}
            columns={[
              { key: 't', header: 'Matter', cell: (i) => TYPE_TEXT[i.type] ?? i.type },
              {
                key: 'd',
                header: 'Days to decide',
                cell: (i) => (
                  <>
                    <Input
                      aria-label={`Days to decide: ${TYPE_TEXT[i.type]}`}
                      type="number"
                      min={1}
                      max={90}
                      value={draft[i.type]?.deadlineDays ?? ''}
                      onChange={(e) => set(i.type, 'deadlineDays', e.target.value)}
                    />
                    <span className="t-error">{fieldError(save.error, `items.${index(i.type)}.deadlineDays`)}</span>
                  </>
                ),
              },
              {
                key: 'h',
                header: 'Threshold (EGP)',
                cell: (i) =>
                  i.thresholded ? (
                    <>
                      <Input
                        aria-label={`Threshold: ${TYPE_TEXT[i.type]}`}
                        inputMode="decimal"
                        placeholder="None"
                        value={draft[i.type]?.threshold ?? ''}
                        onChange={(e) => set(i.type, 'threshold', e.target.value)}
                      />
                      {THRESHOLD_HINT[i.type] ? <span className="t-secondary">{THRESHOLD_HINT[i.type]}</span> : null}
                      <span className="t-error">{fieldError(save.error, `items.${index(i.type)}.threshold`)}</span>
                    </>
                  ) : (
                    '—'
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
