'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardHeader, DataTable, ForbiddenState, PageHeader, Stat, StatusBadge, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { useFinanceCode } from '@/components/finance/codes';
import { InvoiceDetailDialog } from '@/components/finance/invoice-detail';
import { IssueDialog } from '@/components/finance/issue-dialog';
import { RecordPaymentDialog } from '@/components/finance/record-payment';
import { RefundDialog } from '@/components/finance/refund-dialog';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Statement } from '@/lib/queries';
import ar from '@/messages/ar/fin-unit-statement';
import en from '@/messages/en/fin-unit-statement';

/** What a statement entry is called: the ledger's words, a reversal being a payment's. */
const ENTRY: Record<string, string> = { reversal: 'payment_reversal' };

/**
 * Where a unit stands (ADR 0046, 0048): what it owes, its credit, its latest
 * activity; its credit can be refunded.
 */
export default function UnitStatementPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const code = useFinanceCode();
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
        <PageHeader back={<Back href="/finance/invoices" label={t('back')} />} title={t('title')} />
        <ForbiddenState />
      </>
    );
  const s = statement.data;
  return (
    <>
      <PageHeader
        back={<Back href="/finance/invoices" label={t('back')} />}
        title={s ? t('unitTitle', { code: s.unitCode }) : t('title')}
        description={s ? (s.onlinePayment ? t('onlineOn') : t('onlineOff')) : undefined}
        actions={
          <>
            {can('finance.invoice') ? <Button onClick={() => setIssuing(true)}>{t('issue')}</Button> : null}
            {can('finance.refund') && s && Number(s.credit) > 0 ? <Button onClick={() => setRefunding(true)}>{t('refund')}</Button> : null}
            {can('finance.payments') ? (
              <Button variant="primary" onClick={() => setPaying(true)}>
                {t('record')}
              </Button>
            ) : null}
          </>
        }
      />
      <QueryState query={statement}>
        {s ? (
          <div className="stack">
            <div className="row" style={{ gap: 16 }}>
              <Stat label={t('owed')} value={f.money(s.outstanding)} />
              <Stat label={t('credit')} value={f.money(s.credit)} />
            </div>
            <Card flush>
              <CardHeader title={t('oldestFirst')} />
              <DataTable<Statement['openInvoices'][number]>
                rows={s.openInvoices}
                rowKey={(i) => i.id}
                empty={t('nothingOwed')}
                columns={[
                  {
                    key: 'n',
                    header: t('invoice'),
                    cell: (i) => (
                      <Button variant="text" className="table__link t-mono ltr" onClick={() => setOpen(i.id)}>
                        {i.number}
                      </Button>
                    ),
                  },
                  { key: 'd', header: t('due'), cell: (i) => f.day(i.dueOn) },
                  { key: 't', header: c('total'), cell: (i) => f.money(i.total) },
                  { key: 'o', header: t('owed'), cell: (i) => f.money(i.outstanding) },
                  { key: 's', header: c('status'), cell: (i) => <StatusBadge status={i.status} /> },
                ]}
              />
            </Card>
            <Card flush>
              <CardHeader title={t('latest')} />
              <DataTable<Statement['entries'][number]>
                rows={s.entries}
                rowKey={(e) => `${e.kind}-${e.id}`}
                empty={t('noActivity')}
                columns={[
                  {
                    key: 'k',
                    header: '',
                    cell: (e) => (
                      <Badge tone={e.kind === 'payment' || e.kind === 'refund_reversal' ? 'green' : e.kind === 'reversal' || e.kind === 'refund' ? 'error' : 'beige'}>
                        {code('ledger', ENTRY[e.kind] ?? e.kind)}
                      </Badge>
                    ),
                  },
                  { key: 'n', header: t('number'), cell: (e) => <span className="t-mono ltr">{e.number}</span> },
                  {
                    key: 'a',
                    header: c('amount'),
                    cell: (e) =>
                      e.released && Number(e.released) > 0
                        ? t('withRelease', { amount: f.money(e.amount), released: f.money(e.released) })
                        : f.money(e.amount),
                  },
                  { key: 'w', header: t('when'), cell: (e) => f.dateTime(e.at) },
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
