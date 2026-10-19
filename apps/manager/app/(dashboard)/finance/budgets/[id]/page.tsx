'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, ButtonLink, Card, CardHeader, DataTable, ForbiddenState, Input, PageHeader, Select, StatusBadge, Stat, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { Back } from '@/components/community/bits';
import { BUDGET_CATEGORIES, BUDGET_STATUS_TEXT, CATEGORY_TEXT } from '@/components/governance/matters';
import { RaiseApproval } from '@/components/governance/raise';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Budget, type BudgetCategory } from '@/lib/queries';

type Line = Budget['lines'][number];
type DraftLine = { category: BudgetCategory; amount: string; note: string };

/** A draft's lines, replaced as a whole: one per category, each with an amount and a short note. */
function LinesEditor({ budget, onDone }: { budget: Budget; onDone: () => void }) {
  const toast = useToast();
  const [lines, setLines] = useState<DraftLine[]>(
    budget.lines.map((l) => ({ category: l.category, amount: l.amount, note: l.note ?? '' })),
  );
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/staff/finance/budgets/{id}/lines', {
          params: { path: { id: budget.id } },
          body: {
            lines: lines.map((l) => ({ category: l.category, amount: l.amount.trim(), ...(l.note.trim() ? { note: l.note.trim() } : {}) })),
          },
        }),
      ),
    {
      invalidate: [keys.budgetsAll],
      onDone: () => {
        toast.show('Lines saved.');
        onDone();
      },
    },
  );
  const unused = BUDGET_CATEGORIES.filter((c) => !lines.some((l) => l.category === c)) as BudgetCategory[];
  const nextCategory = unused[0];
  const set = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <Card>
      <CardHeader
        title="Lines"
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Button onClick={onDone}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Save the lines
            </Button>
          </span>
        }
      />
      <div className="stack">
        {lines.map((l, i) => (
          <div key={l.category} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Select aria-label="Category" value={l.category} onChange={(e) => set(i, { category: e.target.value as BudgetCategory })}>
              {[l.category, ...unused].map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_TEXT[c]}
                </option>
              ))}
            </Select>
            <span>
              <Input aria-label="Amount (EGP)" inputMode="decimal" placeholder="0.00" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} />
              <span className="t-error">{fieldError(save.error, `lines.${i}.amount`)}</span>
            </span>
            <span style={{ flex: 1 }}>
              <Input aria-label="Note" maxLength={200} placeholder="Note (optional)" value={l.note} onChange={(e) => set(i, { note: e.target.value })} />
              <span className="t-error">{fieldError(save.error, `lines.${i}.note`)}</span>
            </span>
            <Button variant="text" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        {nextCategory ? (
          <Button variant="text" onClick={() => setLines([...lines, { category: nextCategory, amount: '', note: '' }])}>
            Add a line
          </Button>
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Card>
  );
}

/** One budget (ADR 0055): its lines with what each has left; a draft is edited and submitted here. */
export default function BudgetPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('finance.budget');
  const q = useQuery({ queryKey: keys.budget(id), queryFn: () => fetchers.budget(id), enabled: allowed });
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const back = <Back href="/finance/budgets" label="Budgets" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Budget" />
        <ForbiddenState />
      </>
    );
  const b = q.data;
  const draft = b?.status === 'draft';
  return (
    <>
      <PageHeader
        back={back}
        title={b ? `Budget ${b.fiscalYear}` : 'Budget'}
        description={b ? `${b.startsOn} – ${b.endsOn} · ${BUDGET_STATUS_TEXT[b.status]}` : undefined}
        actions={
          b ? (
            <>
              {draft && !editing ? <Button onClick={() => setEditing(true)}>Edit the lines</Button> : null}
              {draft && !editing ? (
                <Button variant="primary" disabled={!b.lines.length || !can('governance.approvals')} onClick={() => setSubmitting(true)}>
                  Submit to the board
                </Button>
              ) : null}
              {b.approvalRequestId && can('governance.approvals') ? (
                <ButtonLink href={`/governance/approvals/${b.approvalRequestId}`}>Its request</ButtonLink>
              ) : null}
              {b.status === 'active' && can('finance.reports') ? <ButtonLink href={`/finance/reports?budget=${b.id}`}>Budget vs actual</ButtonLink> : null}
            </>
          ) : null
        }
      />
      <QueryState query={q}>
        {b ? (
          <div className="stack">
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <Stat label="Budgeted" value={egp(b.totals.budgeted)} />
              <Stat label="Increases" value={egp(b.totals.increases)} />
              <Stat label="Allowance" value={egp(b.totals.allowance)} />
              <Stat label="Spent" value={egp(b.totals.spent)} />
              <Stat label="Remaining" value={egp(b.totals.remaining)} />
            </div>
            {editing ? (
              <LinesEditor budget={b} onDone={() => setEditing(false)} />
            ) : (
              <Card flush>
                <CardHeader title="Lines">
                  <span className="t-secondary">
                    <StatusBadge status={b.status} />
                    {b.submittedAt ? ` · submitted ${formatDateTime(b.submittedAt)}` : ''}
                    {b.decidedAt ? ` · decided ${formatDateTime(b.decidedAt)}` : ''}
                  </span>
                </CardHeader>
                <DataTable<Line>
                  rows={b.lines}
                  rowKey={(l) => l.id}
                  empty={draft ? 'No lines yet: edit the lines to add them' : 'No lines'}
                  columns={[
                    { key: 'c', header: 'Category', cell: (l) => CATEGORY_TEXT[l.category] },
                    { key: 'a', header: 'Budgeted', cell: (l) => egp(l.amount) },
                    { key: 'i', header: 'Increases', cell: (l) => egp(l.increases) },
                    { key: 'w', header: 'Allowance', cell: (l) => egp(l.allowance) },
                    { key: 's', header: 'Spent', cell: (l) => egp(l.spent) },
                    { key: 'r', header: 'Remaining', cell: (l) => egp(l.remaining) },
                    { key: 'n', header: 'Note', cell: (l) => l.note ?? '—' },
                  ]}
                />
              </Card>
            )}
          </div>
        ) : null}
      </QueryState>
      {submitting && b ? <RaiseApproval budgetId={b.id} onClose={() => setSubmitting(false)} /> : null}
    </>
  );
}
