'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RaiseApproval } from '@/components/governance/raise';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CapitalPlan } from '@/lib/queries';
import ar from '@/messages/ar/ops-capital-plans';
import en from '@/messages/en/ops-capital-plans';

type Line = CapitalPlan['lines'][number];

/**
 * A year's capital plan (ADR 0086): its lines while a draft — an asset of
 * the register or words of the staff, and an amount — then to the board as
 * one approval; once approved, nothing of it changes.
 */
export default function CapitalPlanPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('assets.manage');
  const plan = useQuery({ queryKey: keys.capitalPlan(id), queryFn: () => fetchers.capitalPlan(id), enabled: allowed });
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [raising, setRaising] = useState(false);
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/capital-plans/{id}/lines', {
          params: { path: { id } },
          body: { description: description.trim(), amount: amount.trim() },
        }),
      ),
    {
      invalidate: [keys.capitalPlansAll],
      onDone: () => {
        setDescription('');
        setAmount('');
      },
    },
  );
  const remove = useAction(
    (line: Line) =>
      unwrap(api.DELETE('/api/v1/maintenance/capital-plans/{id}/lines/{lineId}', { params: { path: { id, lineId: line.id } } })),
    { invalidate: [keys.capitalPlansAll] },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('planTitle')} />
        <ForbiddenState />
      </>
    );
  const p = plan.data;
  const draft = p?.status === 'draft';
  return (
    <QueryState query={plan}>
      {p ? (
        <>
          <PageHeader
            title={t('planYear', { year: p.year })}
            description={t('planSummary', { n: p.lines.length, total: fmt.money(p.total) })}
            actions={
              <div className="row" style={{ gap: 8 }}>
                <Badge tone={p.status === 'approved' ? 'green' : 'beige'}>{t(`status.${p.status}`)}</Badge>
                {p.approvalRequestId ? <Link href={`/governance/approvals/${p.approvalRequestId}`}>{t('boardRequest')}</Link> : null}
                {draft && can('governance.approvals') ? (
                  <Button variant="primary" disabled={!p.lines.length} onClick={() => setRaising(true)}>
                    {t('submit')}
                  </Button>
                ) : null}
              </div>
            }
          />
          {draft ? (
            <Card>
              <div className="form__row" style={{ padding: 12 }}>
                <Field label={t('what')} error={fieldError(add.error, 'description')}>
                  {(f) => <Input {...f} maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />}
                </Field>
                <Field label={t('amount')} error={fieldError(add.error, 'amount')}>
                  {(f) => <Input {...f} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />}
                </Field>
                <Button loading={add.isPending} disabled={!description.trim() || !amount.trim()} onClick={() => add.mutate(undefined)}>
                  {t('addLine')}
                </Button>
              </div>
              <ErrorAlert error={add.error ?? remove.error} />
            </Card>
          ) : null}
          <Card flush>
            <DataTable<Line>
              rows={p.lines}
              rowKey={(l) => l.id}
              empty={t('noLine')}
              columns={[
                {
                  key: 'asset',
                  header: t('col.asset'),
                  cell: (l) => (l.assetId ? <Link href={`/assets/${l.assetId}`}>{l.assetCode}</Link> : '—'),
                },
                { key: 'type', header: t('col.type'), cell: (l) => (l.assetTypeKey ? label(l.assetTypeKey) : '—') },
                { key: 'what', header: t('col.what'), cell: (l) => l.description },
                { key: 'amount', header: t('col.amount'), cell: (l) => fmt.money(l.amount) },
                { key: 'source', header: t('col.source'), cell: (l) => (l.source === 'computed' ? t('source.computed') : t('source.added')) },
                {
                  key: 'act',
                  header: '',
                  cell: (l) =>
                    draft ? (
                      <Button size="sm" onClick={() => remove.mutate(l)}>
                        {t('remove')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          </Card>
          {raising ? <RaiseApproval capitalPlanId={p.id} onClose={() => setRaising(false)} /> : null}
        </>
      ) : null}
    </QueryState>
  );
}
