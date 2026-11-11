'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, Select, StatusBadge, useCommonT } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useFinanceCode } from '@/components/finance/codes';
import { InvoiceDetailDialog } from '@/components/finance/invoice-detail';
import { IssueDialog } from '@/components/finance/issue-dialog';
import { CHARGE_KINDS, KINDS } from '@/components/finance/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Invoice, type InvoiceFilters, type InvoiceKind } from '@/lib/queries';
import ar from '@/messages/ar/fin-invoices';
import en from '@/messages/en/fin-invoices';

const VIEWS = ['open', 'overdue', 'paid', 'credited', 'rescheduled', 'all'] as const;
type View = (typeof VIEWS)[number];

/**
 * Invoices (ADR 0046): issued to one unit, a building or every unit, or by
 * a billing plan; never edited, corrected by credit notes. What each still
 * asks for is computed from its credit notes and payments.
 */
export default function InvoicesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const code = useFinanceCode();
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const [view, setView] = useState<View>('open');
  const [kind, setKind] = useState<InvoiceKind | ''>('');
  const [building, setBuilding] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const filters: InvoiceFilters = { status: view === 'all' ? '' : view, kind, building: building.trim() };
  const list = useCursorList(keys.invoices(filters), (cursor) => fetchers.invoices(filters, cursor), { enabled: allowed });
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
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setIssuing(true)}>
            {t('issue')}
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<View> label={t('shown')} value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))} />
        <Field label={c('kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as InvoiceKind | '')}>
              <option value="">{t('any')}</option>
              {[...KINDS, ...CHARGE_KINDS].map((v) => (
                <option key={v} value={v}>
                  {code('kind', v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={c('building')}>{(p) => <Input {...p} value={building} onChange={(e) => setBuilding(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Invoice>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={t('empty')}
            columns={[
              {
                key: 'number',
                header: t('col.invoice'),
                cell: (i) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(i.id)}>
                    {i.number}
                  </Button>
                ),
              },
              {
                key: 'unit',
                header: c('unit'),
                cell: (i) => (
                  <Link className="t-mono" href={`/finance/units/${i.unitId}`}>
                    {i.unitCode}
                  </Link>
                ),
              },
              { key: 'kind', header: c('kind'), cell: (i) => code('kind', i.kind) },
              { key: 'total', header: c('total'), cell: (i) => (Number(i.vat) > 0 ? t('total.withVat', { total: fmt.money(i.total), net: fmt.money(i.net), vat: fmt.money(i.vat) }) : fmt.money(i.total)) },
              { key: 'owed', header: t('col.owed'), cell: (i) => fmt.money(i.outstanding) },
              { key: 'due', header: t('col.due'), cell: (i) => fmt.day(i.dueOn) },
              { key: 'status', header: c('status'), cell: (i) => <StatusBadge status={i.status} /> },
              { key: 'when', header: t('col.issued'), cell: (i) => <span title={fmt.dateTime(i.createdAt)}>{fmt.relative(i.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <InvoiceDetailDialog id={open} onClose={() => setOpen(null)} /> : null}
      {issuing ? <IssueDialog onClose={() => setIssuing(false)} /> : null}
    </>
  );
}
