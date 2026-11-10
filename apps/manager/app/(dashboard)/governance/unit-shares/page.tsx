'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, ForbiddenState, Input, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys, shareProblem, type UnitShares } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/gov-unit-shares';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-unit-shares';
import codesEn from '@/messages/en/gov-codes';

type Row = UnitShares['items'][number];

/**
 * The units' ownership shares (ADR 0075): what a poll weighted by share
 * counts each unit by, taken when its voting opens. A unit with none
 * weighs 0. The shares need not add up to 100.
 */
export default function UnitSharesPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
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
    { invalidate: [boardWorkKeys.shares], onDone: () => toast.show(t('saved')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const index = (unitId: string) => changed.findIndex((i) => i.unitId === unitId);
  const problemText = (value: string) => {
    const key = shareProblem(value);
    return key ? g(key) : null;
  };
  return (
    <>
      <PageHeader
        title={t('title')}
        description={
          q.data ? t('recorded', { total: f.percent(Number(q.data.total) / 100, 4), missing: q.data.missing }) : t('weighted')
        }
        actions={
          <Button variant="primary" loading={save.isPending} disabled={!changed.length || problems.length > 0} onClick={() => save.mutate(undefined)}>
            {c('save')}
          </Button>
        }
      />
      <Card flush>
        <QueryState query={q}>
          <DataTable<Row>
            rows={q.data?.items ?? []}
            rowKey={(i) => i.unitId}
            empty={t('none')}
            columns={[
              { key: 'u', header: t('col.unit'), cell: (i) => <span className="ltr">{i.unitCode}</span> },
              {
                key: 's',
                header: t('col.share'),
                cell: (i) => (
                  <>
                    <Input
                      aria-label={t('shareAria', { unit: i.unitCode })}
                      inputMode="decimal"
                      placeholder={t('placeholder')}
                      value={draft[i.unitId] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [i.unitId]: e.target.value }))}
                    />
                    <span className="t-error">
                      {problemText(draft[i.unitId] ?? '') ?? fieldError(save.error, `shares.${index(i.unitId)}.share`)}
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
