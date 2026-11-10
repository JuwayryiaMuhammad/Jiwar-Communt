'use client';

import { useErrorText } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Select, useCommonT, useLabel } from '@jiwar/ui';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useFinanceCode } from '@/components/finance/codes';
import { firstOfMonth } from '@/components/finance/logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type LedgerEntry, type LedgerFilters, type LedgerType } from '@/lib/queries';
import ar from '@/messages/ar/fin-ledger';
import en from '@/messages/en/fin-ledger';

const today = () => new Date().toLocaleDateString('en-CA');

const TYPES: readonly LedgerType[] = [
  'invoice',
  'credit_note',
  'payment',
  'payment_reversal',
  'refund',
  'refund_reversal',
  'credit_applied',
  'allocation_release',
];

/**
 * The compound's ledger (ADR 0048): every money event of a period, from
 * the units' side, computed from the records. Not double-entry. Debits
 * raise what units owe; credits lower it; credit applied and released
 * money move between a unit's credit and an invoice.
 */
export default function LedgerPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const code = useFinanceCode();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('finance.reports');
  const [from, setFrom] = useState(firstOfMonth(today()));
  const [to, setTo] = useState(today());
  const [type, setType] = useState<LedgerType | ''>('');
  const [building, setBuilding] = useState('');
  const errorText = useErrorText();
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const filters: LedgerFilters = { from, to, type, building: building.trim() };
  const list = useCursorList(keys.ledger(filters), (cursor) => fetchers.ledger(filters, cursor), { enabled: allowed && Boolean(from && to) });
  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await download('/api/v1/staff/finance/ledger/export', { from, to, type: type || undefined, building: building.trim() || undefined }, `ledger-${from}_${to}.csv`);
    } catch (e) {
      setExportError(errorText(e));
    } finally {
      setExporting(false);
    }
  };
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
          <Button icon={<Download aria-hidden />} loading={exporting} onClick={() => void exportCsv()}>
            {t('exportCsv')}
          </Button>
        }
      />
      <div className="toolbar">
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label={c('type')}>
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value as LedgerType | '')}>
              <option value="">{t('any')}</option>
              {TYPES.map((v) => (
                <option key={v} value={v}>
                  {code('ledger', v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={c('building')}>{(p) => <Input {...p} value={building} onChange={(e) => setBuilding(e.target.value)} />}</Field>
      </div>
      {exportError ? <Alert tone="error">{exportError}</Alert> : null}
      <Card flush>
        <QueryState query={list}>
          <DataTable<LedgerEntry>
            rows={list.rows}
            rowKey={(e) => `${e.type}-${e.id}`}
            empty={t('empty')}
            columns={[
              { key: 'd', header: t('day'), cell: (e) => <span title={f.dateTime(e.at)}>{f.day(e.day)}</span> },
              { key: 't', header: c('type'), cell: (e) => code('ledger', e.type) },
              { key: 'n', header: t('number'), cell: (e) => <span className="t-mono ltr">{e.number}</span> },
              { key: 'r', header: t('related'), cell: (e) => (e.relatedNumber ? <span className="t-mono ltr">{e.relatedNumber}</span> : '') },
              {
                key: 'u',
                header: c('unit'),
                cell: (e) => (
                  <Link className="t-mono ltr" href={`/finance/units/${e.unitId}`}>
                    {e.unitCode}
                  </Link>
                ),
              },
              { key: 'm', header: t('how'), cell: (e) => (e.method ? code('method', e.method) : e.channel ? label(e.channel) : '') },
              { key: 'dr', header: t('debit'), cell: (e) => (e.debit ? f.money(e.debit) : '') },
              { key: 'cr', header: t('credit'), cell: (e) => (e.credit ? f.money(e.credit) : '') },
              { key: 'a', header: t('moved'), cell: (e) => (e.debit || e.credit ? '' : f.money(e.amount)) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
