'use client';

import { formatDate, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { quarterEnd, quarterStart, quarterWords, withholdingCategoryText } from '@/components/finance/tax';
import { TaxPayDialog } from '@/components/finance/tax-pay-dialog';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Quarter = Schema<'WithholdingQuarterView'>;
type Certificate = Schema<'WithholdingCertificateView'>;
type Vendor = Schema<'TaxVendorView'>;
type Category = NonNullable<Vendor['withholdingCategory']>;
type Tab = 'quarters' | 'certificates' | 'vendors';

const money = (v: string) => <span className="t-mono">{v}</span>;
const CATEGORIES: Category[] = ['supplies', 'services', 'professional', 'exempt'];

function VendorCategory({ v, canWrite }: { v: Vendor; canWrite: boolean }) {
  const toast = useToast();
  const set = useAction(
    (withholdingCategory: Category | null) =>
      unwrap(api.PUT('/api/v1/staff/finance/tax/vendors/{id}', { params: { path: { id: v.id } }, body: { withholdingCategory } })),
    { invalidate: [keys.taxAll], onDone: () => toast.show('Saved.') },
  );
  return (
    <>
      <Select
        aria-label={`Withholding category of ${v.name}`}
        value={v.withholdingCategory ?? ''}
        disabled={!canWrite || set.isPending}
        onChange={(e) => set.mutate(e.target.value === '' ? null : (e.target.value as Category))}
      >
        <option value="">By its trades ({withholdingCategoryText(v.effectiveCategory)})</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {withholdingCategoryText(c)}
          </option>
        ))}
      </Select>
      <ErrorAlert error={set.error} />
    </>
  );
}

/**
 * Withholding tax (ADR 0093): each calendar quarter’s tax withheld from
 * vendors’ payouts, paid and still due, with its report; the certificates
 * each payout gave its vendor, as PDF; and the category each vendor’s
 * payouts withhold by (an invoice may name its own when recorded).
 */
export default function WithholdingPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const canWrite = can('finance.ledger_write');
  const [tab, setTab] = useState<Tab>('quarters');
  const [quarter, setQuarter] = useState('');
  const [paying, setPaying] = useState<Quarter | null>(null);
  const [fileError, setFileError] = useState<unknown>(null);
  const quarters = useQuery({ queryKey: keys.taxQuarters, queryFn: fetchers.taxQuarters, enabled: allowed });
  const certificates = useCursorList(keys.taxCertificates(quarter), (c) => fetchers.taxCertificates(quarter, c), {
    enabled: allowed && tab === 'certificates',
  });
  const vendors = useCursorList(keys.taxVendors, (c) => fetchers.taxVendors(c), { enabled: allowed && tab === 'vendors' });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Withholding tax" />
        <ForbiddenState />
      </>
    );
  const report = (q: Quarter, format: 'pdf' | 'xlsx' | 'csv') =>
    download(
      '/api/v1/staff/reports/export',
      { report: 'tax_withholding', from: quarterStart(q.quarter), to: quarterEnd(q.quarter), groupBy: 'vendor', format },
      `tax_withholding-${q.quarter}.${format}`,
    ).catch(setFileError);
  const pdf = (c: Certificate) =>
    download(`/api/v1/staff/finance/tax/withholding/certificates/${c.id}/pdf`, {}, `${c.number}.pdf`).catch(setFileError);
  return (
    <>
      <PageHeader
        title="Withholding tax"
        description="Deducted from what a vendor is paid and posted to withholding payable; the vendor gets a certificate for each payout, and each quarter’s tax is paid from the treasury."
        actions={<Link href="/finance/tax">Tax settings</Link>}
      />
      <div className="stack">
        <Segmented<Tab>
          label="Withholding"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'quarters', label: 'Quarters' },
            { value: 'certificates', label: 'Certificates' },
            { value: 'vendors', label: 'Vendors’ categories' },
          ]}
        />
        <ErrorAlert error={fileError} />
        {tab === 'quarters' ? (
          <QueryState query={quarters} rows={4}>
            <Card flush>
              <SectionHeader title="The quarters" description="Calendar quarters, newest first: withheld by the certificates, paid, and still due." />
              <DataTable<Quarter>
                rows={quarters.data?.data}
                rowKey={(q) => q.quarter}
                empty="Nothing was withheld yet"
                columns={[
                  { key: 'q', header: 'Quarter', cell: (q) => quarterWords(q.quarter) },
                  { key: 'c', header: 'Certificates', cell: (q) => q.certificates },
                  { key: 'w', header: 'Withheld', cell: (q) => money(q.withheld) },
                  { key: 'p', header: 'Paid', cell: (q) => money(q.paid) },
                  {
                    key: 'o',
                    header: 'Still due',
                    cell: (q) => (Number(q.open) > 0 ? <Badge tone="terracotta">{q.open}</Badge> : money(q.open)),
                  },
                  {
                    key: 'a',
                    header: '',
                    cell: (q) => (
                      <span className="row" style={{ gap: 6 }}>
                        {Number(q.open) > 0 && canWrite ? (
                          <Button size="sm" variant="primary" onClick={() => setPaying(q)}>
                            Pay {q.open}
                          </Button>
                        ) : null}
                        <Button size="sm" onClick={() => void report(q, 'pdf')}>
                          PDF
                        </Button>
                        <Button size="sm" onClick={() => void report(q, 'xlsx')}>
                          Workbook
                        </Button>
                        <Button size="sm" onClick={() => void report(q, 'csv')}>
                          CSV
                        </Button>
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
          </QueryState>
        ) : null}
        {tab === 'certificates' ? (
          <QueryState query={certificates} rows={4}>
            <Card flush>
              <SectionHeader
                title="Certificates"
                description="One for each payout that withheld tax, with its category, rate and base."
              />
              <div style={{ padding: '0 12px 12px' }}>
                <Select aria-label="Quarter" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
                  <option value="">Every quarter</option>
                  {(quarters.data?.data ?? []).map((q) => (
                    <option key={q.quarter} value={q.quarter}>
                      {quarterWords(q.quarter)}
                    </option>
                  ))}
                </Select>
              </div>
              <DataTable<Certificate>
                rows={certificates.rows}
                rowKey={(c) => c.id}
                empty="No certificates"
                columns={[
                  { key: 'n', header: 'Certificate', cell: (c) => c.number },
                  { key: 'v', header: 'Vendor', cell: (c) => `${c.vendorName}${c.vendorTaxNumber ? ` · ${c.vendorTaxNumber}` : ''}` },
                  { key: 'po', header: 'Payout', cell: (c) => c.payoutNumber },
                  { key: 'd', header: 'Paid on', cell: (c) => formatDate(c.paidOn) },
                  { key: 'c', header: 'Category', cell: (c) => `${withholdingCategoryText(c.category)} · ${c.rate}%` },
                  { key: 'b', header: 'On', cell: (c) => money(c.base) },
                  { key: 'a', header: 'Withheld', cell: (c) => money(c.amount) },
                  {
                    key: 'f',
                    header: '',
                    cell: (c) => (
                      <Button size="sm" onClick={() => void pdf(c)}>
                        PDF
                      </Button>
                    ),
                  },
                ]}
              />
              <LoadMore query={certificates} />
            </Card>
          </QueryState>
        ) : null}
        {tab === 'vendors' ? (
          <QueryState query={vendors} rows={4}>
            <Card flush>
              <SectionHeader
                title="Vendors’ categories"
                description="What a vendor’s payouts withhold by. Left to its trades: professional fees if it has that trade, supplies if that is all it does, else services. Exempt withholds nothing."
              />
              <DataTable<Vendor>
                rows={vendors.rows}
                rowKey={(v) => v.id}
                empty="No vendors"
                columns={[
                  { key: 'n', header: 'Vendor', cell: (v) => v.name },
                  { key: 't', header: 'Tax number', cell: (v) => v.taxNumber ?? '' },
                  { key: 'tr', header: 'Trades', cell: (v) => v.categories.join(', ') },
                  { key: 'c', header: 'Withholds by', cell: (v) => <VendorCategory v={v} canWrite={canWrite} /> },
                ]}
              />
              <LoadMore query={vendors} />
            </Card>
          </QueryState>
        ) : null}
      </div>
      {paying ? (
        <TaxPayDialog
          title={`Pay the tax withheld in ${paying.quarter}`}
          due={paying.open}
          what={{ kind: 'withholding', quarter: paying.quarter }}
          onClose={() => setPaying(null)}
        />
      ) : null}
    </>
  );
}
