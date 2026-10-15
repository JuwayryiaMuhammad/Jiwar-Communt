'use client';

import { formatDateTime, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, Select, StatusBadge } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { InvoiceDetailDialog } from '@/components/finance/invoice-detail';
import { IssueDialog } from '@/components/finance/issue-dialog';
import { KIND_TEXT } from '@/components/finance/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Invoice, type InvoiceFilters, type InvoiceKind } from '@/lib/queries';

type View = 'open' | 'overdue' | 'paid' | 'credited' | 'rescheduled' | 'all';

/**
 * Invoices (ADR 0046): issued to one unit, a building or every unit, or by
 * a billing plan; never edited, corrected by credit notes. What each still
 * asks for is computed from its credit notes and payments.
 */
export default function InvoicesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const [view, setView] = useState<View>('open');
  const [kind, setKind] = useState<InvoiceKind | ''>('');
  const [building, setBuilding] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const filters: InvoiceFilters = { status: view === 'all' ? '' : view, kind, building: building.trim() };
  const list = useCursorList(keys.invoices(filters), (c) => fetchers.invoices(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Invoices" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Invoices"
        description="What each unit is asked to pay. Residents who see the unit’s money pay online or at the office."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setIssuing(true)}>
            Issue invoices
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label="Invoices shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Owed' },
            { value: 'overdue', label: 'Overdue' },
            { value: 'paid', label: 'Paid' },
            { value: 'credited', label: 'Credited' },
            { value: 'rescheduled', label: 'Rescheduled' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as InvoiceKind | '')}>
              <option value="">Any</option>
              {Object.entries(KIND_TEXT).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Building">{(p) => <Input {...p} value={building} onChange={(e) => setBuilding(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Invoice>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty="No invoice matches"
            columns={[
              {
                key: 'number',
                header: 'Invoice',
                cell: (i) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(i.id)}>
                    {i.number}
                  </Button>
                ),
              },
              {
                key: 'unit',
                header: 'Unit',
                cell: (i) => (
                  <Link className="t-mono" href={`/finance/units/${i.unitId}`}>
                    {i.unitCode}
                  </Link>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (i) => KIND_TEXT[i.kind] ?? i.kind },
              { key: 'total', header: 'Total', cell: (i) => egp(i.total) },
              { key: 'owed', header: 'Owed', cell: (i) => egp(i.outstanding) },
              { key: 'due', header: 'Due', cell: (i) => i.dueOn },
              { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
              { key: 'when', header: 'Issued', cell: (i) => <span title={formatDateTime(i.createdAt)}>{relativeTime(i.createdAt)}</span> },
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
