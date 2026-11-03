'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { CATEGORY_TEXT } from '@/components/governance/matters';
import { RaiseApproval } from '@/components/governance/raise';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BudgetTransfer, type Commitment } from '@/lib/queries';

/** Budget planning (ADR 0089): transfers, the months, variances and commitments of the active budget. */
export default function BudgetPlanningPage() {
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
  const commitments = useCursorList(keys.commitments({ open: true }), (c) => fetchers.commitments({ open: true }, c), {
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
      onDone: (t) =>
        toast.show(t.status === 'applied' ? 'Moved.' : 'Above the manager’s limit: put it to the board from the list.'),
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
        toast.show('The reason is recorded.');
        setExplaining(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Budget planning" />
        <ForbiddenState />
      </>
    );
  const lines = budget?.lines ?? [];
  const lineText = (id: string) => {
    const l = lines.find((x) => x.id === id);
    return l ? CATEGORY_TEXT[l.category] : '—';
  };
  return (
    <>
      <PageHeader
        title="Budget planning"
        description="Move money between lines (the board above the manager’s limit), read the year by month or quarter, and say why a line ran past its plan. What contracts and approved purchases commit is kept off what a line has available."
      />
      {raising ? <RaiseApproval budgetTransferId={raising} onClose={() => setRaising(null)} /> : null}
      <Card>
        <CardHeader title="Move money between two lines" />
        <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
          <Field label="From" error={fieldError(move.error, 'fromLineId')}>
            {(p) => (
              <Select {...p} value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">Choose a line</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {CATEGORY_TEXT[l.category]} · {egp((l as { available?: string }).available ?? l.remaining)} available
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="To" error={fieldError(move.error, 'toLineId')}>
            {(p) => (
              <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose a line</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {CATEGORY_TEXT[l.category]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="EGP" error={fieldError(move.error, 'amount')}>
            {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Why" error={fieldError(move.error, 'reason')}>
            {(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <Button loading={move.isPending} disabled={!from || !to || !amount.trim() || !reason.trim()} onClick={() => move.mutate()}>
            Move
          </Button>
        </div>
        <ErrorAlert error={move.error} />
        <QueryState query={transfers}>
          <DataTable<BudgetTransfer>
            rows={transfers.data ?? []}
            rowKey={(t) => t.id}
            empty="No transfer"
            columns={[
              { key: 'w', header: 'When', cell: (t) => formatDateTime(t.requestedAt) },
              { key: 'l', header: 'Lines', cell: (t) => `${CATEGORY_TEXT[t.fromCategory]} → ${CATEGORY_TEXT[t.toCategory]}` },
              { key: 'a', header: 'Amount', cell: (t) => egp(t.amount) },
              { key: 's', header: 'Status', cell: (t) => humanize(t.status) },
              {
                key: 'x',
                header: '',
                cell: (t) =>
                  t.status === 'awaiting_board' && !t.approvalRequestId && can('governance.approvals') ? (
                    <Button size="sm" onClick={() => setRaising(t.id)}>
                      Put to the board
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {can('finance.reports') ? (
        <Card>
          <CardHeader
            title="The year by period"
            description={
              periods.data?.varianceReasonPct
                ? `Past ${periods.data.varianceReasonPct}% of its plan, a closed period asks for a reason: ${periods.data.missingReasons} still without one.`
                : 'No variance setting: reasons are optional.'
            }
          />
          <Segmented<'month' | 'quarter'>
            label="By"
            value={by}
            onChange={setBy}
            options={[
              { value: 'month', label: 'Month' },
              { value: 'quarter', label: 'Quarter' },
            ]}
          />
          <QueryState query={periods}>
            <DataTable
              rows={(periods.data?.lines ?? []).flatMap((l) => l.periods.map((p) => ({ ...p, lineId: l.lineId })))}
              rowKey={(r) => `${r.lineId}-${r.period}`}
              columns={[
                { key: 'l', header: 'Line', cell: (r) => lineText(r.lineId) },
                { key: 'p', header: 'Period', cell: (r) => `${r.from} – ${r.to}` },
                { key: 'pl', header: 'Planned', cell: (r) => egp(r.planned) },
                { key: 'a', header: 'Actual', cell: (r) => egp(r.actual) },
                { key: 'v', header: 'Variance', cell: (r) => `${egp(r.variance)}${r.variancePct ? ` (${r.variancePct}%)` : ''}` },
                {
                  key: 'r',
                  header: 'Reason',
                  cell: (r) =>
                    r.reason ? (
                      humanize(r.reason.reasonCode)
                    ) : r.reasonMissing && by === 'month' ? (
                      <Button size="sm" onClick={() => setExplaining({ lineId: r.lineId, month: r.period })}>
                        Say why
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
        <CardHeader title="What is committed" description="Contracts’ unpaid payments in the year and approved purchases, until invoiced." />
        <QueryState query={commitments}>
          <DataTable<Commitment>
            rows={commitments.rows}
            rowKey={(c) => c.id}
            empty="Nothing committed"
            columns={[
              { key: 'l', header: 'Line', cell: (c) => CATEGORY_TEXT[c.category] },
              { key: 's', header: 'From', cell: (c) => humanize(c.source) },
              { key: 'd', header: 'Due', cell: (c) => c.dueOn ?? '—' },
              { key: 'o', header: 'Keeps', cell: (c) => `${egp(c.open)} of ${egp(c.amount)}` },
            ]}
          />
          <LoadMore query={commitments} />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={explaining !== null}
        onClose={() => setExplaining(null)}
        title="Why did the line run past its plan?"
        codes={REASON_CODES.budgetVariance}
        confirmLabel="Record"
        pending={explain.isPending}
        error={<ErrorAlert error={explain.error} />}
        onConfirm={(reasonCode) => explaining && explain.mutate({ ...explaining, reasonCode })}
      />
    </>
  );
}
