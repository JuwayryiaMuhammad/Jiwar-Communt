'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, Checkbox, DataTable, ForbiddenState, Input, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { codeText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GovernanceSetting } from '@/lib/queries';
import ar from '@/messages/ar/gov-settings';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-settings';
import codesEn from '@/messages/en/gov-codes';

type Draft = Record<string, { deadlineDays: string; threshold: string; binding: boolean }>;

const EMPTY = { deadlineDays: '', threshold: '', binding: false };

/** How long the board has for each kind of matter, and the thresholds (ADR 0055). */
export default function GovernanceSettingsPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const q = useQuery({ queryKey: keys.governanceSettings, queryFn: fetchers.governanceSettings, enabled: allowed });
  const [draft, setDraft] = useState<Draft>({});
  useEffect(() => {
    if (q.data)
      setDraft(
        Object.fromEntries(
          q.data.items.map((i) => [i.type, { deadlineDays: String(i.deadlineDays), threshold: i.threshold ?? '', binding: i.binding }]),
        ),
      );
  }, [q.data]);
  /** A setting's draft; one the list has not loaded yet is empty. */
  const at = (type: string) => draft[type] ?? EMPTY;
  const changed = (q.data?.items ?? []).filter((i) => {
    const d = draft[i.type];
    return (
      d &&
      (d.deadlineDays !== String(i.deadlineDays) ||
        (i.thresholded && d.threshold.trim() !== (i.threshold ?? '')) ||
        (i.bindable && d.binding !== i.binding))
    );
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
              ...(i.bindable ? { binding: at(i.type).binding } : {}),
            })),
          },
        }),
      ),
    { invalidate: [keys.governanceSettings], onDone: () => toast.show(t('saved')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const set = (type: string, field: 'deadlineDays' | 'threshold' | 'binding', value: string | boolean) =>
    setDraft((d) => ({ ...d, [type]: { ...(d[type] ?? EMPTY), [field]: value } }));
  // The errors name the items as sent: the changed ones, in order.
  const index = (type: string) => changed.findIndex((i) => i.type === type);
  const typeText = (type: string) => (type === 'board_appeal' ? t('typeBoardAppeal') : codeText(g, 'approvalType', type));
  const hint = (type: string) =>
    type === 'major_contract' || type === 'waiver_above_limit' || type === 'payment_plan_above_limit' ? t(`hint.${type}`) : null;
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" loading={save.isPending} disabled={!changed.length} onClick={() => save.mutate(undefined)}>
            {c('save')}
          </Button>
        }
      />
      <Card flush>
        <QueryState query={q}>
          <DataTable<GovernanceSetting>
            rows={q.data?.items ?? []}
            rowKey={(i) => i.type}
            columns={[
              { key: 't', header: t('col.matter'), cell: (i) => typeText(i.type) },
              {
                key: 'd',
                header: t('col.days'),
                cell: (i) => (
                  <>
                    <Input
                      aria-label={t('daysAria', { matter: typeText(i.type) })}
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
                header: t('col.threshold'),
                cell: (i) =>
                  i.thresholded ? (
                    <>
                      <Input
                        aria-label={t('thresholdAria', { matter: typeText(i.type) })}
                        inputMode="decimal"
                        placeholder={t('none')}
                        value={draft[i.type]?.threshold ?? ''}
                        onChange={(e) => set(i.type, 'threshold', e.target.value)}
                      />
                      {hint(i.type) ? <span className="t-secondary">{hint(i.type)}</span> : null}
                      <span className="t-error">{fieldError(save.error, `items.${index(i.type)}.threshold`)}</span>
                    </>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'b',
                header: t('col.binding'),
                cell: (i) =>
                  i.bindable ? (
                    <>
                      <Checkbox
                        label={t('aboveItBoardDecides')}
                        checked={at(i.type).binding}
                        onChange={(e) => set(i.type, 'binding', e.target.checked)}
                      />
                      <span className="t-error">{fieldError(save.error, `items[${index(i.type)}].binding`)}</span>
                    </>
                  ) : i.binding ? (
                    t('always')
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
