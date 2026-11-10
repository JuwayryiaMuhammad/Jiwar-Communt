'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { codeText } from '@/components/governance/logic';
import { RaiseApproval } from '@/components/governance/raise';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BudgetTransfer, type Commitment } from '@/lib/queries';
import ar from '@/messages/ar/fin-budget-planning';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/fin-budget-planning';
import codesEn from '@/messages/en/gov-codes';

/** Budget planning (ADR 0089): transfers, the months, variances and commitments of the active budget. */
export default function BudgetPlanningPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('finance.budget');
  const active = useQuery({ queryKey: keys.budgets('active'), queryFn: () => fetchers.budgets('active', undefined, 1), enabled: allowed });
  const budget = active.data?.data[0];
  const [by, setBy] = useState<'month' | 'quarter'>('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [raising, setRaising] = useState<string | null>(null);
  const [explaining, setExplaining] = useState<{ lineId: string; month: number } | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const transfers = useQuery({
    queryKey: keys.budgetTransfers(budget?.id ?? ''),
    queryFn: () => fetchers.budgetTransfers(budget!.id),
    enabled: !!budget,
  });
  const periods = useQuery({
    queryKey: keys.budgetPeriods(budget?.id ?? '', by),
    queryFn: () => fetchers.budgetPeriods(budget!.id, by),
    enabled: !!budget && can('finance.reports'),
  });
  const commitments = useCursorList(keys.commitments({ open: true }), (cursor) => fetchers.commitments({ open: true }, cursor), {
    enabled: allowed,
  });
  const move = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/budget-transfers', {
          params: { header: { 'Idempotency-Key': key } },
          body: { fromLineId: from, toLineId: to, amount: amount.trim(), reason: reason.trim() },
        }),
      ),
    {
      invalidate: [keys.budgetsAll],
      onDone: (r) => toast.show(r.status === 'applied' ? t('moved') : t('aboveLimit')),
    },
  );
  const explain = useAction(
    (v: { lineId: string; month: number; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/finance/budget-lines/{id}/variance-reasons', {
          params: { path: { id: v.lineId } },
          body: { month: v.month, reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [keys.budgetsAll],
      onDone: () => {
        toast.show(t('reasonRecorded'));
        setExplaining(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const lines = budget?.lines ?? [];
  const category = (code: string) => codeText(g, 'category', code);
  const lineText = (id: string) => {
    const l = lines.find((x) => x.id === id);
    return l ? category(l.category) : '—';
  };
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {raising ? <RaiseApproval budgetTransferId={raising} onClose={() => setRaising(null)} /> : null}
      <Card>
        <CardHeader title={t('moveTitle')} />
        <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
          <Field label={c('from')} error={fieldError(move.error, 'fromLineId')}>
            {(p) => (
              <Select {...p} value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">{t('chooseLine')}</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {t('lineAvailable', { category: category(l.category), amount: f.money((l as { available?: string }).available ?? l.remaining) })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={c('to')} error={fieldError(move.error, 'toLineId')}>
            {(p) => (
              <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">{t('chooseLine')}</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {category(l.category)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('egp')} error={fieldError(move.error, 'amount')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label={t('why')} error={fieldError(move.error, 'reason')}>
            {(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <Button loading={move.isPending} disabled={!from || !to || !amount.trim() || !reason.trim()} onClick={() => move.mutate()}>
            {t('move')}
          </Button>
        </div>
        <ErrorAlert error={move.error} />
        <QueryState query={transfers}>
          <DataTable<BudgetTransfer>
            rows={transfers.data ?? []}
            rowKey={(r) => r.id}
            empty={t('noTransfer')}
            columns={[
              { key: 'w', header: t('col.when'), cell: (r) => f.dateTime(r.requestedAt) },
              { key: 'l', header: t('col.lines'), cell: (r) => `${category(r.fromCategory)} → ${category(r.toCategory)}` },
              { key: 'a', header: c('amount'), cell: (r) => f.money(r.amount) },
              { key: 's', header: c('status'), cell: (r) => label(r.status) },
              {
                key: 'x',
                header: '',
                cell: (r) =>
                  r.status === 'awaiting_board' && !r.approvalRequestId && can('governance.approvals') ? (
                    <Button size="sm" onClick={() => setRaising(r.id)}>
                      {t('putToBoard')}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {can('finance.reports') ? (
        <Card>
          <SectionHeader
            title={t('yearTitle')}
            description={
              periods.data?.varianceReasonPct
                ? t('varianceDescription', { pct: f.number(periods.data.varianceReasonPct), missing: f.number(periods.data.missingReasons) })
                : t('noVariance')
            }
          />
          <Segmented<'month' | 'quarter'>
            label={t('by')}
            value={by}
            onChange={setBy}
            options={[
              { value: 'month', label: t('month') },
              { value: 'quarter', label: t('quarter') },
            ]}
          />
          <QueryState query={periods}>
            <DataTable
              rows={(periods.data?.lines ?? []).flatMap((l) => l.periods.map((p) => ({ ...p, lineId: l.lineId })))}
              rowKey={(r) => `${r.lineId}-${r.period}`}
              columns={[
                { key: 'l', header: t('col.line'), cell: (r) => lineText(r.lineId) },
                { key: 'p', header: t('col.period'), cell: (r) => `${f.day(r.from)} – ${f.day(r.to)}` },
                { key: 'pl', header: t('col.planned'), cell: (r) => f.money(r.planned) },
                { key: 'a', header: t('col.actual'), cell: (r) => f.money(r.actual) },
                {
                  key: 'v',
                  header: t('col.variance'),
                  cell: (r) => `${f.money(r.variance)}${r.variancePct ? ` (${f.number(r.variancePct)}%)` : ''}`,
                },
                {
                  key: 'r',
                  header: c('reason'),
                  cell: (r) =>
                    r.reason ? (
                      label(r.reason.reasonCode)
                    ) : r.reasonMissing && by === 'month' ? (
                      <Button size="sm" onClick={() => setExplaining({ lineId: r.lineId, month: r.period })}>
                        {t('sayWhy')}
                      </Button>
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          </QueryState>
        </Card>
      ) : null}
      <Card flush>
        <SectionHeader title={t('committedTitle')} description={t('committedDescription')} />
        <QueryState query={commitments}>
          <DataTable<Commitment>
            rows={commitments.rows}
            rowKey={(r) => r.id}
            empty={t('nothingCommitted')}
            columns={[
              { key: 'l', header: t('col.line'), cell: (r) => category(r.category) },
              { key: 's', header: t('col.source'), cell: (r) => label(r.source) },
              { key: 'd', header: t('col.due'), cell: (r) => (r.dueOn ? f.day(r.dueOn) : '—') },
              { key: 'o', header: t('col.keeps'), cell: (r) => t('keeps', { open: f.money(r.open), amount: f.money(r.amount) }) },
            ]}
          />
          <LoadMore query={commitments} />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={explaining !== null}
        onClose={() => setExplaining(null)}
        title={t('explainTitle')}
        codes={REASON_CODES.budgetVariance}
        confirmLabel={t('record')}
        pending={explain.isPending}
        error={<ErrorAlert error={explain.error} />}
        onConfirm={(reasonCode) => explaining && explain.mutate({ ...explaining, reasonCode })}
      />
    </>
  );
}
