'use client';

import { formatDateTime } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, Button, Card, CardHeader, DataTable, ForbiddenState, PageHeader, Stat, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { Back } from '@/components/facilities/bits';
import { InvoiceDetailDialog } from '@/components/finance/invoice-detail';
import { IssueDialog } from '@/components/finance/issue-dialog';
import { RecordPaymentDialog } from '@/components/finance/record-payment';
import { RefundDialog } from '@/components/finance/refund-dialog';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Statement } from '@/lib/queries';

const ENTRY: Record<string, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  payment: 'Payment',
  reversal: 'Reversal',
  refund: 'Refund',
  refund_reversal: 'Refund reversed',
};

/**
 * Where a unit stands (ADR 0046, 0048): what it owes, its credit, its latest
 * activity; its credit can be refunded.
 */
export default function UnitStatementPage() {
  const { unitId } = useParams<{ unitId: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice') || can('finance.payments');
  const statement = useQuery({ queryKey: keys.statement(unitId), queryFn: () => fetchers.statement(unitId), enabled: allowed });
  const [open, setOpen] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [refunding, setRefunding] = useState(false);
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/finance/invoices" label="Invoices" />} title="Unit statement" />
        <ForbiddenState />
      </>
    );
  const s = statement.data;
  return (
    <>
      <PageHeader
        back={<Back href="/finance/invoices" label="Invoices" />}
        title={s ? `Unit ${s.unitCode}` : 'Unit statement'}
        description={s ? (s.onlinePayment ? 'Its residents can pay online.' : 'Online payment is off in this compound.') : undefined}
        actions={
          <>
            {can('finance.invoice') ? <Button onClick={() => setIssuing(true)}>Issue an invoice</Button> : null}
            {can('finance.refund') && s && Number(s.credit) > 0 ? <Button onClick={() => setRefunding(true)}>Refund credit</Button> : null}
            {can('finance.payments') ? (
              <Button variant="primary" onClick={() => setPaying(true)}>
                Record a payment
              </Button>
            ) : null}
          </>
        }
      />
      <QueryState query={statement}>
        {s ? (
          <div className="stack">
            <div className="row" style={{ gap: 16 }}>
              <Stat label="Owed" value={egp(s.outstanding)} />
              <Stat label="Credit" value={egp(s.credit)} />
            </div>
            <Card flush>
              <CardHeader title="Owed, oldest due first" />
              <DataTable<Statement['openInvoices'][number]>
                rows={s.openInvoices}
                rowKey={(i) => i.id}
                empty="Nothing owed"
                columns={[
                  {
                    key: 'n',
                    header: 'Invoice',
                    cell: (i) => (
                      <Button variant="text" className="table__link t-mono" onClick={() => setOpen(i.id)}>
                        {i.number}
                      </Button>
                    ),
                  },
                  { key: 'd', header: 'Due', cell: (i) => i.dueOn },
                  { key: 't', header: 'Total', cell: (i) => egp(i.total) },
                  { key: 'o', header: 'Owed', cell: (i) => egp(i.outstanding) },
                  { key: 's', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
                ]}
              />
            </Card>
            <Card flush>
              <CardHeader title="Latest activity" />
              <DataTable<Statement['entries'][number]>
                rows={s.entries}
                rowKey={(e) => `${e.kind}-${e.id}`}
                empty="No activity yet"
                columns={[
                  {
                    key: 'k',
                    header: '',
                    cell: (e) => (
                      <Badge tone={e.kind === 'payment' || e.kind === 'refund_reversal' ? 'green' : e.kind === 'reversal' || e.kind === 'refund' ? 'error' : 'beige'}>
                        {ENTRY[e.kind] ?? e.kind}
                      </Badge>
                    ),
                  },
                  { key: 'n', header: 'Number', cell: (e) => <span className="t-mono">{e.number}</span> },
                  {
                    key: 'a',
                    header: 'Amount',
                    cell: (e) => (e.released && Number(e.released) > 0 ? `${egp(e.amount)} (${egp(e.released)} back to credit)` : egp(e.amount)),
                  },
                  { key: 'w', header: 'When', cell: (e) => formatDateTime(e.at) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </QueryState>
      {open ? <InvoiceDetailDialog id={open} onClose={() => setOpen(null)} /> : null}
      {paying ? <RecordPaymentDialog unitId={unitId} onClose={() => setPaying(false)} /> : null}
      {issuing ? <IssueDialog unitId={unitId} onClose={() => setIssuing(false)} /> : null}
      {refunding && s ? <RefundDialog unitId={unitId} credit={s.credit} onClose={() => setRefunding(false)} /> : null}
    </>
  );
}
