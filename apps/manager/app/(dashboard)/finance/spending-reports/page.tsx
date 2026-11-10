'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { codeText, inLocale } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import govAr from '@/messages/ar/gov-codes';
import ar from '@/messages/ar/fin-spending-reports';
import govEn from '@/messages/en/gov-codes';
import en from '@/messages/en/fin-spending-reports';

type Report = Schema<'SpendingReportView'>;
type Budget = Schema<'BudgetView'>;
type Publication = Schema<'BoardPublicationView'>;
type Item = { textEn: string; textAr: string; decisionPublicationId: string };
const KEY = ['finance', 'spending-reports'] as const;

/** A first report of a budget, or — with `supersedes` — a newer one replacing its latest. */
function Publish({ supersedes, onClose }: { supersedes?: Report; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
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
        toast.show(supersedes ? t('publish.supersededDone') : t('publish.done'));
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
      title={supersedes ? t('publish.supersedeTitle', { year: String(supersedes.fiscalYear), asOf: f.day(supersedes.asOf) }) : t('publish.title')}
      description={supersedes ? t('publish.supersedeDescription') : t('publish.description')}
      onSubmit={() => summaryOk && itemsOk && publish.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={publish.isPending} disabled={!summaryOk || !itemsOk}>
            {t('publish.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        {budgets.data && !supersedes ? (
          <Field label={t('budget')} hint={t('budgetHint')} error={fieldError(publish.error, 'budgetId')}>
            {(p) => (
              <Select {...p} value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
                <option value="">{t('yearUnderWay')}</option>
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
        <Field label={t('summaryEn')} hint={t('summaryHint')} error={fieldError(publish.error, 'summaryEn') ?? (!summaryOk ? t('summaryBoth') : undefined)}>
          {(p) => <Textarea {...p} maxLength={2000} rows={3} dir="ltr" lang="en" value={summaryEn} onChange={(e) => setSummaryEn(e.target.value)} />}
        </Field>
        <Field label={t('summaryAr')} error={fieldError(publish.error, 'summaryAr')}>
          {(p) => <Textarea {...p} maxLength={2000} rows={3} dir="rtl" lang="ar" value={summaryAr} onChange={(e) => setSummaryAr(e.target.value)} />}
        </Field>
        {items.map((item, i) => (
          <Card key={i}>
            <div className="form" style={{ padding: 12 }}>
              <Field label={t('improvement', { n: f.number(i + 1) })} error={fieldError(publish.error, `items.${i}.textEn`)}>
                {(p) => <Input {...p} maxLength={500} dir="ltr" lang="en" value={item.textEn} onChange={(e) => set(i, { textEn: e.target.value })} />}
              </Field>
              <Field label={t('inArabic')} error={fieldError(publish.error, `items.${i}.textAr`)}>
                {(p) => <Input {...p} maxLength={500} dir="rtl" lang="ar" value={item.textAr} onChange={(e) => set(i, { textAr: e.target.value })} />}
              </Field>
              {decisions.data ? (
                <Field label={t('decision')} error={fieldError(publish.error, `items.${i}.decisionPublicationId`)}>
                  {(p) => (
                    <Select {...p} value={item.decisionPublicationId} onChange={(e) => set(i, { decisionPublicationId: e.target.value })}>
                      <option value="">{c('none')}</option>
                      {decisions.data.data
                        .filter((d: Publication) => d.kind === 'decision' && !d.archivedAt)
                        .map((d: Publication) => (
                          <option key={d.id} value={d.id}>
                            {f.day(d.decidedOn)} · {inLocale(locale, d.titleEn, d.titleAr)}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
              ) : null}
              <div>
                <Button size="sm" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  {c('remove')}
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {items.length < 20 ? (
          <div>
            <Button size="sm" icon={<Plus aria-hidden />} onClick={() => setItems([...items, { textEn: '', textAr: '', decisionPublicationId: '' }])}>
              {t('addImprovement')}
            </Button>
          </div>
        ) : null}
        <ErrorAlert error={publish.error} />
      </div>
    </Dialog>
  );
}

function Detail({ report, onClose }: { report: Report; onClose: () => void }) {
  const t = useT(en, ar);
  const gov = useT(govEn, govAr);
  const f = useFormat();
  const { locale } = useLocale();
  const params = { year: String(report.fiscalYear), asOf: f.day(report.asOf) };
  return (
    <Dialog
      open
      onClose={onClose}
      title={report.supersededById ? t('detailSuperseded', params) : t('detailTitle', params)}
      description={inLocale(locale, report.summaryEn, report.summaryAr) === '—' ? undefined : inLocale(locale, report.summaryEn, report.summaryAr)}
    >
      <Card flush>
        <DataTable<Report['lines'][number]>
          rows={report.lines}
          rowKey={(l) => l.category}
          empty={t('noCategory')}
          columns={[
            { key: 'c', header: t('category'), cell: (l) => codeText(gov, 'category', l.category) },
            { key: 'a', header: t('allowed'), cell: (l) => f.money(l.allowance) },
            { key: 's', header: t('spent'), cell: (l) => f.money(l.spent) },
            { key: 'u', header: t('used'), cell: (l) => f.percent(Number(l.usedPct) / 100, 1) },
          ]}
        />
      </Card>
      {report.items.length ? (
        <ul>
          {report.items.map((i) => (
            <li key={i.position}>{inLocale(locale, i.textEn, i.textAr)}</li>
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
  const t = useT(en, ar);
  const f = useFormat();
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
          can('finance.reports') ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setPublishing(true)}>
              {t('publish')}
            </Button>
          ) : undefined
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Report>
            rows={list.data?.data}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              {
                key: 'y',
                header: t('year'),
                cell: (r) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(r)}>
                    {r.fiscalYear}
                  </Button>
                ),
              },
              {
                key: 'st',
                header: t('residents'),
                cell: (r) => (r.supersededById ? <Badge tone="beige">{t('superseded')}</Badge> : <Badge tone="green">{t('reading')}</Badge>),
              },
              { key: 'o', header: t('asOf'), cell: (r) => f.day(r.asOf) },
              {
                key: 's',
                header: t('spent'),
                cell: (r) =>
                  t('spentLine', {
                    spent: f.money(r.totals.spent),
                    allowance: f.money(r.totals.allowance),
                    pct: f.percent(Number(r.totals.usedPct) / 100, 1),
                  }),
              },
              { key: 'i', header: t('improvements'), cell: (r) => f.number(r.items.length) },
              { key: 'p', header: t('published'), cell: (r) => f.dateTime(r.publishedAt) },
              {
                key: 'a',
                header: '',
                className: 'table__actions',
                cell: (r) =>
                  can('finance.reports') && !r.supersededById ? (
                    <Button size="sm" onClick={() => setSuperseding(r)}>
                      {t('supersede')}
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
