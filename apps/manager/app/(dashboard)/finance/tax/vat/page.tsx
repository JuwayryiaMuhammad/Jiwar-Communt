'use client';

import { formatDateTime, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, ConfirmDialog, DataTable, ForbiddenState, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { monthEnd, vatStatusText } from '@/components/finance/tax';
import { TaxPayDialog } from '@/components/finance/tax-pay-dialog';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Month = Schema<'VatMonthView'>;
const money = (v: string) => <span className="t-mono">{v}</span>;
const tone = (m: Month) => (m.status === 'declared' ? 'dark' : m.status === 'ready' ? 'green' : 'beige');

/**
 * The monthly VAT declaration (ADR 0093): a month’s output VAT, input VAT
 * and what is due or carried forward, from the ledger once it closed the
 * month. Declaring locks the month’s figures; settling the VAT due is a
 * payout from a treasury account. The report is also on the reports
 * platform (PDF, workbook, CSV, scheduled).
 */
export default function VatPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const canWrite = can('finance.ledger_write');
  const toast = useToast();
  const [declaring, setDeclaring] = useState<Month | null>(null);
  const [paying, setPaying] = useState<Month | null>(null);
  const [fileError, setFileError] = useState<unknown>(null);
  const months = useQuery({ queryKey: keys.taxVatMonths, queryFn: fetchers.taxVatMonths, enabled: allowed });
  const declare = useAction(
    (month: string) => unwrap(api.POST('/api/v1/staff/finance/tax/vat/declarations', { body: { month } })),
    {
      invalidate: [keys.taxAll],
      onDone: (m) => {
        toast.show(`${m.month} is declared.`);
        setDeclaring(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="VAT declaration" />
        <ForbiddenState />
      </>
    );
  const file = (m: Month, format: 'pdf' | 'xlsx' | 'csv') =>
    download(
      '/api/v1/staff/reports/export',
      { report: 'tax_vat', from: `${m.month}-01`, to: monthEnd(m.month), groupBy: 'month', format },
      `tax_vat-${m.month}.${format}`,
    ).catch(setFileError);
  return (
    <>
      <PageHeader
        title="VAT declaration"
        description="Output VAT on the invoices, input VAT recovered on vendors’ invoices, and the net due or carried forward. A month is declared once the ledger has closed it, in order."
        actions={
          <span className="row" style={{ gap: 12 }}>
            <Link href="/finance/tax">Tax settings</Link>
            <Link href="/finance/gl/periods">Closing months</Link>
          </span>
        }
      />
      <ErrorAlert error={fileError} />
      <QueryState query={months} rows={6}>
        <Card flush>
          <SectionHeader title="The months" description="Newest first, from the month VAT began. Nothing before it carries VAT." />
          <DataTable<Month>
            rows={months.data?.data}
            rowKey={(m) => m.month}
            empty="VAT is not turned on, or has not begun yet"
            columns={[
              { key: 'm', header: 'Month', cell: (m) => m.month },
              { key: 's', header: 'Status', cell: (m) => <Badge tone={tone(m)}>{vatStatusText(m.status)}</Badge> },
              { key: 'ts', header: 'Taxable sales', cell: (m) => money(m.taxableSales) },
              { key: 'o', header: 'Output VAT', cell: (m) => money(m.outputVat) },
              { key: 'tp', header: 'Taxable purchases', cell: (m) => money(m.taxablePurchases) },
              { key: 'i', header: 'Input VAT', cell: (m) => money(m.inputVat) },
              { key: 'ci', header: 'Carried in', cell: (m) => money(m.carriedIn) },
              { key: 'n', header: 'Net due', cell: (m) => money(m.netDue) },
              { key: 'co', header: 'Carried forward', cell: (m) => money(m.carriedOut) },
              { key: 'p', header: 'Paid', cell: (m) => (m.declarationId ? money(m.paid) : '') },
              {
                key: 'd',
                header: 'Declared',
                cell: (m) => (m.declaredAt ? `${formatDateTime(m.declaredAt)} · ${m.declaredBy?.fullName ?? '—'}` : ''),
              },
              {
                key: 'a',
                header: '',
                cell: (m) => (
                  <span className="row" style={{ gap: 6 }}>
                    {m.status === 'ready' && canWrite ? (
                      <Button size="sm" variant="primary" onClick={() => setDeclaring(m)}>
                        Declare
                      </Button>
                    ) : null}
                    {m.status === 'declared' && Number(m.open) > 0 && canWrite ? (
                      <Button size="sm" onClick={() => setPaying(m)}>
                        Pay {m.open}
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => void file(m, 'pdf')}>
                      PDF
                    </Button>
                    <Button size="sm" onClick={() => void file(m, 'xlsx')}>
                      Workbook
                    </Button>
                    <Button size="sm" onClick={() => void file(m, 'csv')}>
                      CSV
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </Card>
      </QueryState>
      <ConfirmDialog
        open={declaring !== null}
        onClose={() => setDeclaring(null)}
        title={`Declare the VAT of ${declaring?.month ?? ''}?`}
        description="Its figures are locked, the input set off against the output, and the month cannot be reopened in the ledger after."
        confirmLabel="Declare"
        pending={declare.isPending}
        error={<ErrorAlert error={declare.error} />}
        onConfirm={() => declaring && declare.mutate(declaring.month)}
      />
      {paying ? (
        <TaxPayDialog
          title={`Pay the VAT of ${paying.month}`}
          due={paying.open}
          what={{ kind: 'vat', declarationId: paying.declarationId ?? '' }}
          onClose={() => setPaying(null)}
        />
      ) : null}
    </>
  );
}
