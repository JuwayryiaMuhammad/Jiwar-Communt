'use client';

import { errorText, formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Alert, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, Select } from '@jiwar/ui';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { firstOfMonth, LEDGER_TEXT, METHOD_TEXT } from '@/components/finance/logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type LedgerEntry, type LedgerFilters, type LedgerType } from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');

/**
 * The compound's ledger (ADR 0048): every money event of a period, from
 * the units' side, computed from the records. Not double-entry. Debits
 * raise what units owe; credits lower it; credit applied and released
 * money move between a unit's credit and an invoice.
 */
export default function LedgerPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.reports');
  const [from, setFrom] = useState(firstOfMonth(today()));
  const [to, setTo] = useState(today());
  const [type, setType] = useState<LedgerType | ''>('');
  const [building, setBuilding] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const filters: LedgerFilters = { from, to, type, building: building.trim() };
  const list = useCursorList(keys.ledger(filters), (c) => fetchers.ledger(filters, c), { enabled: allowed && Boolean(from && to) });
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
        <PageHeader title="Ledger" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Ledger"
        description="Every invoice, credit note, payment and refund of the period, and their reversals, oldest first."
        actions={
          <Button icon={<Download aria-hidden />} loading={exporting} onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        }
      />
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Type">
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value as LedgerType | '')}>
              <option value="">Any</option>
              {Object.entries(LEDGER_TEXT).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Building">{(p) => <Input {...p} value={building} onChange={(e) => setBuilding(e.target.value)} />}</Field>
      </div>
      {exportError ? <Alert tone="error">{exportError}</Alert> : null}
      <Card flush>
        <QueryState query={list}>
          <DataTable<LedgerEntry>
            rows={list.rows}
            rowKey={(e) => `${e.type}-${e.id}`}
            empty="Nothing in this period"
            columns={[
              { key: 'd', header: 'Day', cell: (e) => <span title={formatDateTime(e.at)}>{e.day}</span> },
              { key: 't', header: 'Type', cell: (e) => LEDGER_TEXT[e.type] ?? e.type },
              { key: 'n', header: 'Number', cell: (e) => <span className="t-mono">{e.number}</span> },
              { key: 'r', header: 'Related', cell: (e) => (e.relatedNumber ? <span className="t-mono">{e.relatedNumber}</span> : '') },
              {
                key: 'u',
                header: 'Unit',
                cell: (e) => (
                  <Link className="t-mono" href={`/finance/units/${e.unitId}`}>
                    {e.unitCode}
                  </Link>
                ),
              },
              { key: 'm', header: 'How', cell: (e) => (e.method ? (METHOD_TEXT[e.method] ?? e.method) : (e.channel ?? '')) },
              { key: 'dr', header: 'Debit', cell: (e) => (e.debit ? egp(e.debit) : '') },
              { key: 'cr', header: 'Credit', cell: (e) => (e.credit ? egp(e.credit) : '') },
              { key: 'a', header: 'Moved', cell: (e) => (e.debit || e.credit ? '' : egp(e.amount)) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
