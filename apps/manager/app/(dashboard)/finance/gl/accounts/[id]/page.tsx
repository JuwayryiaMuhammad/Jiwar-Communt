'use client';

import { humanize, type Schema } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { addDays, today } from '@/components/security/logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Line = Schema<'GlLedgerLineView'>;

const money = (v: string) => <span className="t-mono">{v}</span>;

/**
 * An account's ledger (ADR 0092): its lines of a period, oldest first, each
 * with the account's balance after it; a page at a time, and its CSV.
 */
export default function AccountLedgerPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const [cursors, setCursors] = useState<string[]>(['']);
  const cursor = cursors[cursors.length - 1] ?? '';
  const account = useQuery({ queryKey: keys.glAccount(id), queryFn: () => fetchers.glAccount(id), enabled: allowed });
  const opening = useQuery({
    queryKey: [...keys.glChart(addDays(from, -1)), id],
    queryFn: async () => (await fetchers.glChart(addDays(from, -1))).accounts.find((a) => a.id === id),
    enabled: allowed,
  });
  const lines = useQuery({
    queryKey: keys.glLedger(id, from, to, cursor),
    queryFn: () => fetchers.glLedger(id, from, to, cursor),
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Account ledger" />
        <ForbiddenState />
      </>
    );
  const a = account.data?.account;
  return (
    <>
      <PageHeader
        title={a ? `${a.code} ${a.nameEn}` : 'Account ledger'}
        description={a ? `${a.nameAr} · ${a.type} · balance today ${a.balance}` : undefined}
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Field label="From">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setCursors(['']);
                  }}
                />
              )}
            </Field>
            <Field label="To">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setCursors(['']);
                  }}
                />
              )}
            </Field>
            <Button
              onClick={() => void download(`/api/v1/staff/finance/gl/accounts/${id}/ledger/export`, { from, to }, 'ledger.csv')}
            >
              Export CSV
            </Button>
          </span>
        }
      />
      <QueryState query={lines} rows={6}>
        {lines.data ? (
          <Card flush>
            <SectionHeader
              title="Lines"
              description={`Opening balance ${opening.data ? `${opening.data.balance} (its own and its sub-accounts’)` : '…'} on ${addDays(from, -1)}.`}
            />
            <DataTable<Line>
              rows={lines.data.data}
              rowKey={(l) => `${l.entryId}-${l.lineNo}`}
              empty="No line in this period"
              columns={[
                { key: 'd', header: 'Day', cell: (l) => (l.eventOn === l.postedOn ? l.postedOn : `${l.postedOn} (of ${l.eventOn})`) },
                { key: 's', header: 'From', cell: (l) => humanize(l.source) },
                { key: 'r', header: 'Reference', cell: (l) => l.reference ?? '—' },
                { key: 'u', header: 'Unit', cell: (l) => l.unitCode ?? '' },
                { key: 'm', header: 'Memo', cell: (l) => l.memo ?? '' },
                { key: 'dr', header: 'Debit', cell: (l) => (l.debit === '0.00' ? '' : money(l.debit)) },
                { key: 'cr', header: 'Credit', cell: (l) => (l.credit === '0.00' ? '' : money(l.credit)) },
                { key: 'b', header: 'Balance', cell: (l) => money(l.balance) },
              ]}
            />
            <div className="row" style={{ gap: 8, padding: 12 }}>
              <Button disabled={cursors.length < 2} onClick={() => setCursors((c) => c.slice(0, -1))}>
                Previous
              </Button>
              <Button
                disabled={!lines.data.nextCursor}
                onClick={() => lines.data?.nextCursor && setCursors((c) => [...c, lines.data!.nextCursor!])}
              >
                Next
              </Button>
            </div>
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
