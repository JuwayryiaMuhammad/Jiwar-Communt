'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, Segmented, Select, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { quarterEnd, quarterStart } from '@/components/finance/tax';
import { TaxPayDialog } from '@/components/finance/tax-pay-dialog';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-tax-withholding';
import en from '@/messages/en/fin-tax-withholding';

type Quarter = Schema<'WithholdingQuarterView'>;
type Certificate = Schema<'WithholdingCertificateView'>;
type Vendor = Schema<'TaxVendorView'>;
type Category = NonNullable<Vendor['withholdingCategory']>;
type Tab = 'quarters' | 'certificates' | 'vendors';

const CATEGORIES: Category[] = ['supplies', 'services', 'professional', 'exempt'];

function VendorCategory({ v, canWrite }: { v: Vendor; canWrite: boolean }) {
  const t = useT(en, ar);
  const label = useLabel();
  const toast = useToast();
  const set = useAction(
    (withholdingCategory: Category | null) =>
      unwrap(api.PUT('/api/v1/staff/finance/tax/vendors/{id}', { params: { path: { id: v.id } }, body: { withholdingCategory } })),
    { invalidate: [keys.taxAll], onDone: () => toast.show(t('saved')) },
  );
  return (
    <>
      <Select
        aria-label={t('categoryOf', { name: v.name })}
        value={v.withholdingCategory ?? ''}
        disabled={!canWrite || set.isPending}
        onChange={(e) => set.mutate(e.target.value === '' ? null : (e.target.value as Category))}
      >
        <option value="">{t('byTrades', { category: label(v.effectiveCategory) })}</option>
        {CATEGORIES.map((cat) => (
          <option key={cat} value={cat}>
            {label(cat)}
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
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
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
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const money = (v: string) => <span className="t-mono">{f.money(v)}</span>;
  const quarterWords = (q: Quarter) =>
    t('quarterRange', {
      quarter: q.quarter,
      from: f.month(q.startsOn),
      to: f.month(q.endsOn),
    });
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
        title={t('title')}
        description={t('description')}
        actions={<Link href="/finance/tax">{t('settingsLink')}</Link>}
      />
      <div className="stack">
        <Segmented<Tab>
          label={t('tabs')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'quarters', label: t('quarters') },
            { value: 'certificates', label: t('certificates') },
            { value: 'vendors', label: t('vendors') },
          ]}
        />
        <ErrorAlert error={fileError} />
        {tab === 'quarters' ? (
          <QueryState query={quarters} rows={4}>
            <Card flush>
              <SectionHeader title={t('quartersTitle')} description={t('quartersHint')} />
              <DataTable<Quarter>
                rows={quarters.data?.data}
                rowKey={(q) => q.quarter}
                empty={t('quartersEmpty')}
                columns={[
                  { key: 'q', header: t('quarter'), cell: (q) => quarterWords(q) },
                  { key: 'c', header: t('certificateCount'), cell: (q) => f.number(q.certificates) },
                  { key: 'w', header: t('withheld'), cell: (q) => money(q.withheld) },
                  { key: 'p', header: t('paid'), cell: (q) => money(q.paid) },
                  {
                    key: 'o',
                    header: t('stillDue'),
                    cell: (q) => (Number(q.open) > 0 ? <Badge tone="terracotta">{f.money(q.open)}</Badge> : money(q.open)),
                  },
                  {
                    key: 'a',
                    header: '',
                    cell: (q) => (
                      <span className="row" style={{ gap: 6 }}>
                        {Number(q.open) > 0 && canWrite ? (
                          <Button size="sm" variant="primary" onClick={() => setPaying(q)}>
                            {t('pay', { amount: f.money(q.open) })}
                          </Button>
                        ) : null}
                        <Button size="sm" onClick={() => void report(q, 'pdf')}>
                          {t('pdf')}
                        </Button>
                        <Button size="sm" onClick={() => void report(q, 'xlsx')}>
                          {t('workbook')}
                        </Button>
                        <Button size="sm" onClick={() => void report(q, 'csv')}>
                          {t('csv')}
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
              <SectionHeader title={t('certificatesTitle')} description={t('certificatesHint')} />
              <div style={{ padding: '0 12px 12px' }}>
                <Select aria-label={t('quarter')} value={quarter} onChange={(e) => setQuarter(e.target.value)}>
                  <option value="">{t('everyQuarter')}</option>
                  {(quarters.data?.data ?? []).map((q) => (
                    <option key={q.quarter} value={q.quarter}>
                      {quarterWords(q)}
                    </option>
                  ))}
                </Select>
              </div>
              <DataTable<Certificate>
                rows={certificates.rows}
                rowKey={(c) => c.id}
                empty={t('certificatesEmpty')}
                columns={[
                  { key: 'n', header: t('certificate'), cell: (c) => c.number },
                  { key: 'v', header: t('vendor'), cell: (c) => `${c.vendorName}${c.vendorTaxNumber ? ` · ${c.vendorTaxNumber}` : ''}` },
                  { key: 'po', header: t('payout'), cell: (c) => c.payoutNumber },
                  { key: 'd', header: t('paidOn'), cell: (c) => f.day(c.paidOn) },
                  {
                    key: 'c',
                    header: t('category'),
                    cell: (c) => t('categoryRate', { category: label(c.category), rate: f.percent(Number(c.rate) / 100, 2) }),
                  },
                  { key: 'b', header: t('base'), cell: (c) => money(c.base) },
                  { key: 'a', header: t('withheld'), cell: (c) => money(c.amount) },
                  {
                    key: 'f',
                    header: '',
                    cell: (c) => (
                      <Button size="sm" onClick={() => void pdf(c)}>
                        {t('pdf')}
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
              <SectionHeader title={t('vendorsTitle')} description={t('vendorsHint')} />
              <DataTable<Vendor>
                rows={vendors.rows}
                rowKey={(v) => v.id}
                empty={t('vendorsEmpty')}
                columns={[
                  { key: 'n', header: t('vendor'), cell: (v) => v.name },
                  { key: 't', header: t('taxNumber'), cell: (v) => v.taxNumber ?? '' },
                  { key: 'tr', header: t('trades'), cell: (v) => f.list(v.categories.map((x) => label(x))) },
                  { key: 'c', header: t('withholdsBy'), cell: (v) => <VendorCategory v={v} canWrite={canWrite} /> },
                ]}
              />
              <LoadMore query={vendors} />
            </Card>
          </QueryState>
        ) : null}
      </div>
      {paying ? (
        <TaxPayDialog
          title={t('payTitle', { quarter: paying.quarter })}
          due={paying.open}
          what={{ kind: 'withholding', quarter: paying.quarter }}
          onClose={() => setPaying(null)}
        />
      ) : null}
    </>
  );
}
