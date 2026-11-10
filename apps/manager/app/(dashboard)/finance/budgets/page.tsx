'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Budget, type BudgetStatus } from '@/lib/queries';
import ar from '@/messages/ar/fin-budgets';
import en from '@/messages/en/fin-budgets';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function Draft({ budgets, onClose }: { budgets: Budget[]; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const router = useRouter();
  const thisYear = new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState(String(thisYear + 1));
  const [copyFromId, setCopyFromId] = useState('');
  const draft = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/budgets', {
          body: { fiscalYear: Number(fiscalYear), ...(copyFromId ? { copyFromId } : {}) },
        }),
      ),
    {
      invalidate: [keys.budgetsAll],
      onDone: (b) => {
        toast.show(t('drafted'));
        onClose();
        router.push(`/finance/budgets/${b.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('draftABudget')}
      description={t('draftDescription')}
      onSubmit={() => draft.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={draft.isPending}>
            {t('draft')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('fiscalYear')} error={fieldError(draft.error, 'fiscalYear')}>
          {(p) => (
            <Select {...p} value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)}>
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('copyFrom')} error={fieldError(draft.error, 'copyFromId')}>
          {(p) => (
            <Select {...p} value={copyFromId} onChange={(e) => setCopyFromId(e.target.value)}>
              <option value="">{t('copyNothing')}</option>
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.fiscalYear} · {t(`status.${b.status}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={draft.error} />
      </div>
    </Dialog>
  );
}

function FiscalYearSetting() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const q = useQuery({ queryKey: keys.budgetSettings, queryFn: fetchers.budgetSettings });
  const [month, setMonth] = useState('');
  useEffect(() => {
    if (q.data) setMonth(String(q.data.fiscalYearStartMonth));
  }, [q.data]);
  const save = useAction(
    () => unwrap(api.PATCH('/api/v1/staff/finance/budget-settings', { body: { fiscalYearStartMonth: Number(month) } })),
    { invalidate: [keys.budgetSettings], onDone: () => toast.show(c('saved')) },
  );
  return (
    <Card>
      <CardHeader title={t('fiscalYear')}>
        <span className="t-secondary">{t('fiscalYearHint')}</span>
      </CardHeader>
      <QueryState query={q}>
        <div className="toolbar">
          <Field label={t('startsIn')} error={fieldError(save.error, 'fiscalYearStartMonth')}>
            {(p) => (
              <Select {...p} value={month} onChange={(e) => setMonth(e.target.value)}>
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {f.custom(Date.UTC(2000, m - 1, 1), { month: 'long', timeZone: 'UTC' })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button
            loading={save.isPending}
            disabled={!q.data || month === String(q.data.fiscalYearStartMonth)}
            onClick={() => save.mutate(undefined)}
          >
            {c('save')}
          </Button>
        </div>
        <ErrorAlert error={save.error} />
      </QueryState>
    </Card>
  );
}

/** The compound's annual budgets (ADR 0055): drafted here, approved by the board, then spent against. */
export default function BudgetsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('finance.budget');
  const [status, setStatus] = useState<BudgetStatus | ''>('');
  const [drafting, setDrafting] = useState(false);
  const list = useCursorList(keys.budgets(status), (cursor) => fetchers.budgets(status, cursor), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setDrafting(true)}>
            {t('draftABudget')}
          </Button>
        }
      />
      <div className="stack">
        <FiscalYearSetting />
        <div className="toolbar">
          <Segmented<BudgetStatus | ''>
            label={c('status')}
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: c('all') },
              { value: 'draft', label: t('filter.draft') },
              { value: 'submitted', label: t('status.submitted') },
              { value: 'active', label: t('status.active') },
              { value: 'rejected', label: t('status.rejected') },
              { value: 'withdrawn', label: t('status.withdrawn') },
            ]}
          />
        </div>
        <Card flush>
          <QueryState query={list}>
            <DataTable<Budget>
              rows={list.rows}
              rowKey={(b) => b.id}
              empty={t('none')}
              columns={[
                { key: 'y', header: t('fiscalYear'), cell: (b) => <Link href={`/finance/budgets/${b.id}`}>{b.fiscalYear}</Link> },
                { key: 'p', header: t('col.period'), cell: (b) => `${f.day(b.startsOn)} – ${f.day(b.endsOn)}` },
                { key: 't', header: t('col.budgeted'), cell: (b) => f.money(b.totals.budgeted) },
                { key: 'r', header: t('col.remaining'), cell: (b) => (b.status === 'active' ? f.money(b.totals.remaining) : '—') },
                { key: 'c', header: c('created'), cell: (b) => f.dateTime(b.createdAt) },
                { key: 's', header: c('status'), cell: (b) => <StatusBadge status={b.status} label={t(`status.${b.status}`)} /> },
              ]}
            />
            <LoadMore query={list} />
          </QueryState>
        </Card>
      </div>
      {drafting ? <Draft budgets={list.rows ?? []} onClose={() => setDrafting(false)} /> : null}
    </>
  );
}
