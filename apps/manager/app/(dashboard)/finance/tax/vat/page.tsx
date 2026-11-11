'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, ConfirmDialog, DataTable, ForbiddenState, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { monthEnd } from '@/components/finance/tax';
import { TaxPayDialog } from '@/components/finance/tax-pay-dialog';
import { api } from '@/lib/api';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-tax-vat';
import en from '@/messages/en/fin-tax-vat';

type Month = Schema<'VatMonthView'>;
const tone = (m: Month) => (m.status === 'declared' ? 'dark' : m.status === 'ready' ? 'green' : 'beige');

/**
 * The monthly VAT declaration (ADR 0093): a month’s output VAT, input VAT
 * and what is due or carried forward, from the ledger once it closed the
 * month. Declaring locks the month’s figures; settling the VAT due is a
 * payout from a treasury account. The report is also on the reports
 * platform (PDF, workbook, CSV, scheduled).
 */
export default function VatPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const money = (v: string) => <span className="t-mono">{f.money(v)}</span>;
  const c = useCommonT();
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
        toast.show(t('declareDone', { month: f.month(m.month) }));
        setDeclaring(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
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
        title={t('title')}
        description={t('description')}
        actions={
          <span className="row" style={{ gap: 12 }}>
            <Link href="/finance/tax">{t('settingsLink')}</Link>
            <Link href="/finance/gl/periods">{t('periodsLink')}</Link>
          </span>
        }
      />
      <ErrorAlert error={fileError} />
      <QueryState query={months} rows={6}>
        <Card flush>
          <SectionHeader title={t('months')} description={t('monthsHint')} />
          <DataTable<Month>
            rows={months.data?.data}
            rowKey={(m) => m.month}
            empty={t('empty')}
            columns={[
              { key: 'm', header: t('month'), cell: (m) => f.month(m.month) },
              { key: 's', header: c('status'), cell: (m) => <Badge tone={tone(m)}>{t(m.status)}</Badge> },
              { key: 'ts', header: t('taxableSales'), cell: (m) => money(m.taxableSales) },
              { key: 'o', header: t('outputVat'), cell: (m) => money(m.outputVat) },
              { key: 'tp', header: t('taxablePurchases'), cell: (m) => money(m.taxablePurchases) },
              { key: 'i', header: t('inputVat'), cell: (m) => money(m.inputVat) },
              { key: 'ci', header: t('carriedIn'), cell: (m) => money(m.carriedIn) },
              { key: 'n', header: t('netDue'), cell: (m) => money(m.netDue) },
              { key: 'co', header: t('carriedOut'), cell: (m) => money(m.carriedOut) },
              { key: 'p', header: t('paid'), cell: (m) => (m.declarationId ? money(m.paid) : '') },
              {
                key: 'd',
                header: t('declaredOn'),
                cell: (m) => (m.declaredAt ? `${f.dateTime(m.declaredAt)} · ${m.declaredBy?.fullName ?? '—'}` : ''),
              },
              {
                key: 'a',
                header: '',
                cell: (m) => (
                  <span className="row" style={{ gap: 6 }}>
                    {m.status === 'ready' && canWrite ? (
                      <Button size="sm" variant="primary" onClick={() => setDeclaring(m)}>
                        {t('declare')}
                      </Button>
                    ) : null}
                    {m.status === 'declared' && Number(m.open) > 0 && canWrite ? (
                      <Button size="sm" onClick={() => setPaying(m)}>
                        {t('pay', { amount: f.money(m.open) })}
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => void file(m, 'pdf')}>
                      {t('pdf')}
                    </Button>
                    <Button size="sm" onClick={() => void file(m, 'xlsx')}>
                      {t('workbook')}
                    </Button>
                    <Button size="sm" onClick={() => void file(m, 'csv')}>
                      {t('csv')}
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
        title={t('declareTitle', { month: f.month(declaring?.month) })}
        description={t('declareDescription')}
        confirmLabel={t('declare')}
        pending={declare.isPending}
        error={<ErrorAlert error={declare.error} />}
        onConfirm={() => declaring && declare.mutate(declaring.month)}
      />
      {paying ? (
        <TaxPayDialog
          title={t('payTitle', { month: f.month(paying.month) })}
          due={paying.open}
          what={{ kind: 'vat', declarationId: paying.declarationId ?? '' }}
          onClose={() => setPaying(null)}
        />
      ) : null}
    </>
  );
}
