'use client';

import { fieldError, formatDateTime, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Report = Schema<'SpendingReportView'>;
type Budget = Schema<'BudgetView'>;
type Publication = Schema<'BoardPublicationView'>;
type Item = { textEn: string; textAr: string; decisionPublicationId: string };
const KEY = ['finance', 'spending-reports'] as const;
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');

/** A first report of a budget, or — with `supersedes` — a newer one replacing its latest. */
function Publish({ supersedes, onClose }: { supersedes?: Report; onClose: () => void }) {
  const toast = useToast();
  const { can } = usePermissions();
  const budgets = useQuery({
    queryKey: ['finance', 'budgets', 'active'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/budgets', { params: { query: { limit: 50 } } })),
    enabled: can('finance.budget') && !supersedes,
  });
  const decisions = useQuery({
    queryKey: ['governance', 'publications', 'decisions'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/governance/publications', { params: { query: { limit: 100 } } })),
    enabled: can('governance.manage'),
  });
  const [budgetId, setBudgetId] = useState('');
  const [summaryEn, setSummaryEn] = useState('');
  const [summaryAr, setSummaryAr] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const publish = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/spending-reports', {
          body: {
            ...(supersedes ? { supersedesId: supersedes.id } : budgetId ? { budgetId } : {}),
            ...(summaryEn.trim() ? { summaryEn: summaryEn.trim(), summaryAr: summaryAr.trim() } : {}),
            items: items.map((i) => ({
              textEn: i.textEn.trim(),
              textAr: i.textAr.trim(),
              ...(i.decisionPublicationId ? { decisionPublicationId: i.decisionPublicationId } : {}),
            })),
          },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(
          supersedes
            ? 'Published: residents now read this one only; the earlier report stays here.'
            : 'Published: everyone who pays a unit’s charges is told, tenants included.',
        );
        onClose();
      },
    },
  );
  const summaryOk = (summaryEn.trim() === '') === (summaryAr.trim() === '');
  const itemsOk = items.every((i) => i.textEn.trim() !== '' && i.textAr.trim() !== '');
  const set = (i: number, patch: Partial<Item>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Dialog
      open
      onClose={onClose}
      title={supersedes ? `Supersede the ${supersedes.fiscalYear} report of ${supersedes.asOf}` : 'Publish where the fees went'}
      description={
        supersedes
          ? 'A published report never changes: this newer one, of the same budget as of today, replaces it for residents. The earlier one stays readable here.'
          : 'The budget’s figures by category as of today, frozen once published, and the improvements it paid for in your words. Never an expense, a vendor or a name.'
      }
      onSubmit={() => summaryOk && itemsOk && publish.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={publish.isPending} disabled={!summaryOk || !itemsOk}>
            Publish
          </Button>
        </>
      }
    >
      <div className="form">
        {budgets.data && !supersedes ? (
          <Field label="Budget" hint="The year under way’s when left out." error={fieldError(publish.error, 'budgetId')}>
            {(p) => (
              <Select {...p} value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
                <option value="">The year under way</option>
                {budgets.data.data
                  .filter((b: Budget) => b.status === 'active')
                  .map((b: Budget) => (
                    <option key={b.id} value={b.id}>
                      {b.fiscalYear}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Summary in English" hint="Both languages, or neither." error={fieldError(publish.error, 'summaryEn') ?? (!summaryOk ? 'Write it in both languages, or neither.' : undefined)}>
          {(p) => <Textarea {...p} maxLength={2000} rows={3} value={summaryEn} onChange={(e) => setSummaryEn(e.target.value)} />}
        </Field>
        <Field label="Summary in Arabic" error={fieldError(publish.error, 'summaryAr')}>
          {(p) => <Textarea {...p} maxLength={2000} rows={3} dir="rtl" lang="ar" value={summaryAr} onChange={(e) => setSummaryAr(e.target.value)} />}
        </Field>
        {items.map((item, i) => (
          <Card key={i}>
            <div className="form" style={{ padding: 12 }}>
              <Field label={`Improvement ${i + 1}, in English`} error={fieldError(publish.error, `items.${i}.textEn`)}>
                {(p) => <Input {...p} maxLength={500} value={item.textEn} onChange={(e) => set(i, { textEn: e.target.value })} />}
              </Field>
              <Field label="In Arabic" error={fieldError(publish.error, `items.${i}.textAr`)}>
                {(p) => <Input {...p} maxLength={500} dir="rtl" lang="ar" value={item.textAr} onChange={(e) => set(i, { textAr: e.target.value })} />}
              </Field>
              {decisions.data ? (
                <Field label="The board’s decision it carried out" error={fieldError(publish.error, `items.${i}.decisionPublicationId`)}>
                  {(p) => (
                    <Select {...p} value={item.decisionPublicationId} onChange={(e) => set(i, { decisionPublicationId: e.target.value })}>
                      <option value="">None</option>
                      {decisions.data.data
                        .filter((d: Publication) => d.kind === 'decision' && !d.archivedAt)
                        .map((d: Publication) => (
                          <option key={d.id} value={d.id}>
                            {d.decidedOn} · {d.titleEn}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
              ) : null}
              <div>
                <Button size="sm" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {items.length < 20 ? (
          <div>
            <Button size="sm" icon={<Plus aria-hidden />} onClick={() => setItems([...items, { textEn: '', textAr: '', decisionPublicationId: '' }])}>
              Add an improvement
            </Button>
          </div>
        ) : null}
        <ErrorAlert error={publish.error} />
      </div>
    </Dialog>
  );
}

function Detail({ report, onClose }: { report: Report; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${report.fiscalYear}, as of ${report.asOf}${report.supersededById ? ' (superseded)' : ''}`}
      description={report.summaryEn ?? undefined}
    >
      <Card flush>
        <DataTable<Report['lines'][number]>
          rows={report.lines}
          rowKey={(l) => l.category}
          empty="No category"
          columns={[
            { key: 'c', header: 'Category', cell: (l) => label(l.category) },
            { key: 'a', header: 'Allowed', cell: (l) => `${l.allowance} EGP` },
            { key: 's', header: 'Spent', cell: (l) => `${l.spent} EGP` },
            { key: 'u', header: 'Used', cell: (l) => `${l.usedPct}%` },
          ]}
        />
      </Card>
      {report.items.length ? (
        <ul>
          {report.items.map((i) => (
            <li key={i.position}>{i.textEn}</li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}

/**
 * Where the fees went (ADR 0069): snapshots of an approved budget by
 * category, published to everyone who pays a unit’s charges — tenants as
 * well as owners — and frozen once published. A newer report of a budget
 * supersedes its latest: residents read only that, the staff every one.
 */
export default function SpendingReportsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.reports') || can('finance.budget');
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/spending-reports')),
    enabled: allowed,
  });
  const [publishing, setPublishing] = useState(false);
  const [superseding, setSuperseding] = useState<Report | null>(null);
  const [open, setOpen] = useState<Report | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Where the fees went" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Where the fees went"
        description="What the residents read of the budget: each category’s allowance and spend, and what the fees paid for."
        actions={
          can('finance.reports') ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setPublishing(true)}>
              Publish a report
            </Button>
          ) : undefined
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Report>
            rows={list.data?.data}
            rowKey={(r) => r.id}
            empty="Nothing published yet"
            columns={[
              {
                key: 'y',
                header: 'Year',
                cell: (r) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(r)}>
                    {r.fiscalYear}
                  </Button>
                ),
              },
              {
                key: 'st',
                header: 'Residents',
                cell: (r) => (r.supersededById ? <Badge tone="beige">Superseded</Badge> : <Badge tone="green">Reading</Badge>),
              },
              { key: 'o', header: 'As of', cell: (r) => r.asOf },
              { key: 's', header: 'Spent', cell: (r) => `${r.totals.spent} of ${r.totals.allowance} EGP (${r.totals.usedPct}%)` },
              { key: 'i', header: 'Improvements', cell: (r) => r.items.length },
              { key: 'p', header: 'Published', cell: (r) => formatDateTime(r.publishedAt) },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (r) =>
                  can('finance.reports') && !r.supersededById ? (
                    <Button size="sm" onClick={() => setSuperseding(r)}>
                      Supersede
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {publishing ? <Publish onClose={() => setPublishing(false)} /> : null}
      {superseding ? <Publish supersedes={superseding} onClose={() => setSuperseding(null)} /> : null}
      {open ? <Detail report={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
