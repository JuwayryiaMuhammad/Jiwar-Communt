'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  ButtonLink,
  Card,
  CardHeader,
  DataTable,
  ForbiddenState,
  Input,
  PageHeader,
  Select,
  Stat,
  StatusBadge,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { codeText } from '@/components/governance/logic';
import { BUDGET_CATEGORIES } from '@/components/governance/matters';
import { RaiseApproval } from '@/components/governance/raise';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Budget, type BudgetCategory } from '@/lib/queries';
import ar from '@/messages/ar/fin-budgets';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/fin-budgets';
import codesEn from '@/messages/en/gov-codes';

type Line = Budget['lines'][number];
type DraftLine = { category: BudgetCategory; amount: string; note: string };

/** A draft's lines, replaced as a whole: one per category, each with an amount and a short note. */
function LinesEditor({ budget, onDone }: { budget: Budget; onDone: () => void }) {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
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
        toast.show(t('linesSaved'));
        onDone();
      },
    },
  );
  const unused = BUDGET_CATEGORIES.filter((k) => !lines.some((l) => l.category === k)) as BudgetCategory[];
  const nextCategory = unused[0];
  const set = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <Card>
      <CardHeader
        title={t('lines')}
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Button onClick={onDone}>{c('cancel')}</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
              {t('saveLines')}
            </Button>
          </span>
        }
      />
      <div className="stack">
        {lines.map((l, i) => (
          <div key={l.category} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Select aria-label={t('category')} value={l.category} onChange={(e) => set(i, { category: e.target.value as BudgetCategory })}>
              {[l.category, ...unused].map((k) => (
                <option key={k} value={k}>
                  {codeText(g, 'category', k)}
                </option>
              ))}
            </Select>
            <span>
              <Input
                aria-label={t('amountEgp')}
                inputMode="decimal"
                className="ltr"
                placeholder="0.00"
                value={l.amount}
                onChange={(e) => set(i, { amount: e.target.value })}
              />
              <span className="t-error">{fieldError(save.error, `lines.${i}.amount`)}</span>
            </span>
            <span style={{ flex: 1 }}>
              <Input
                aria-label={c('note')}
                maxLength={200}
                placeholder={t('notePlaceholder')}
                value={l.note}
                onChange={(e) => set(i, { note: e.target.value })}
              />
              <span className="t-error">{fieldError(save.error, `lines.${i}.note`)}</span>
            </span>
            <Button variant="text" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              {c('remove')}
            </Button>
          </div>
        ))}
        {nextCategory ? (
          <Button variant="text" onClick={() => setLines([...lines, { category: nextCategory, amount: '', note: '' }])}>
            {t('addLine')}
          </Button>
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Card>
  );
}

/** One budget (ADR 0055): its lines with what each has left; a draft is edited and submitted here. */
export default function BudgetPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('finance.budget');
  const q = useQuery({ queryKey: keys.budget(id), queryFn: () => fetchers.budget(id), enabled: allowed });
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const back = <Back href="/finance/budgets" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('budget')} />
        <ForbiddenState />
      </>
    );
  const b = q.data;
  const draft = b?.status === 'draft';
  return (
    <>
      <PageHeader
        back={back}
        title={b ? t('budgetYear', { year: b.fiscalYear }) : t('budget')}
        description={b ? `${f.day(b.startsOn)} – ${f.day(b.endsOn)} · ${t(`status.${b.status}`)}` : undefined}
        actions={
          b ? (
            <>
              {draft && !editing ? <Button onClick={() => setEditing(true)}>{t('editLines')}</Button> : null}
              {draft && !editing ? (
                <Button variant="primary" disabled={!b.lines.length || !can('governance.approvals')} onClick={() => setSubmitting(true)}>
                  {t('submitToBoard')}
                </Button>
              ) : null}
              {b.approvalRequestId && can('governance.approvals') ? (
                <ButtonLink href={`/governance/approvals/${b.approvalRequestId}`}>{t('itsRequest')}</ButtonLink>
              ) : null}
              {b.status === 'active' && can('finance.reports') ? (
                <ButtonLink href={`/finance/reports?budget=${b.id}`}>{t('budgetVsActual')}</ButtonLink>
              ) : null}
            </>
          ) : null
        }
      />
      <QueryState query={q}>
        {b ? (
          <div className="stack">
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <Stat label={t('col.budgeted')} value={f.money(b.totals.budgeted)} />
              <Stat label={t('increases')} value={f.money(b.totals.increases)} />
              <Stat label={t('allowance')} value={f.money(b.totals.allowance)} />
              <Stat label={t('spent')} value={f.money(b.totals.spent)} />
              <Stat label={t('col.remaining')} value={f.money(b.totals.remaining)} />
            </div>
            {editing ? (
              <LinesEditor budget={b} onDone={() => setEditing(false)} />
            ) : (
              <Card flush>
                <CardHeader title={t('lines')}>
                  <span className="t-secondary">
                    <StatusBadge status={b.status} label={t(`status.${b.status}`)} />
                    {b.submittedAt ? t('submittedOn', { when: f.dateTime(b.submittedAt) }) : ''}
                    {b.decidedAt ? t('decidedOn', { when: f.dateTime(b.decidedAt) }) : ''}
                  </span>
                </CardHeader>
                <DataTable<Line>
                  rows={b.lines}
                  rowKey={(l) => l.id}
                  empty={draft ? t('noLinesDraft') : t('noLines')}
                  columns={[
                    { key: 'c', header: t('category'), cell: (l) => codeText(g, 'category', l.category) },
                    { key: 'a', header: t('col.budgeted'), cell: (l) => f.money(l.amount) },
                    { key: 'i', header: t('increases'), cell: (l) => f.money(l.increases) },
                    { key: 'w', header: t('allowance'), cell: (l) => f.money(l.allowance) },
                    { key: 's', header: t('spent'), cell: (l) => f.money(l.spent) },
                    { key: 'r', header: t('col.remaining'), cell: (l) => f.money(l.remaining) },
                    { key: 'n', header: c('note'), cell: (l) => l.note ?? '—' },
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
