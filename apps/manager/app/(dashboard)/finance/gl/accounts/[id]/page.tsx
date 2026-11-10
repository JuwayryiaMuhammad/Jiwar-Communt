'use client';

import type { Schema } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Format } from '@jiwar/i18n';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { addDays, today } from '@/components/security/logic';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/money-gl';
import en from '@/messages/en/money-gl';

type Line = Schema<'GlLedgerLineView'>;

const amount = (fmt: Format, v: string) => fmt.number(v, { minimumFractionDigits: 2 });
const money = (fmt: Format, v: string) => <span className="t-mono">{amount(fmt, v)}</span>;

/**
 * An account's ledger (ADR 0092): its lines of a period, oldest first, each
 * with the account's balance after it; a page at a time, and its CSV.
 */
export default function AccountLedgerPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
        <PageHeader title={t('ledger.title')} />
        <ForbiddenState />
      </>
    );
  const a = account.data?.account;
  const openingDay = fmt.day(addDays(from, -1));
  return (
    <>
      <PageHeader
        title={a ? `${a.code} ${locale === 'ar' ? a.nameAr : a.nameEn}` : t('ledger.title')}
        description={
          a
            ? t('ledger.description', { name: locale === 'ar' ? a.nameEn : a.nameAr, type: label(a.type), balance: amount(fmt, a.balance) })
            : undefined
        }
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Field label={c('from')}>
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
            <Field label={c('to')}>
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
              {t('exportCsv')}
            </Button>
          </span>
        }
      />
      <QueryState query={lines} rows={6}>
        {lines.data ? (
          <Card flush>
            <SectionHeader
              title={t('lines')}
              description={
                opening.data
                  ? t('openingKnown', { balance: amount(fmt, opening.data.balance), day: openingDay })
                  : t('openingLoading', { day: openingDay })
              }
            />
            <DataTable<Line>
              rows={lines.data.data}
              rowKey={(l) => `${l.entryId}-${l.lineNo}`}
              empty={t('noLine')}
              columns={[
                {
                  key: 'd',
                  header: t('col.day'),
                  cell: (l) => (l.eventOn === l.postedOn ? fmt.day(l.postedOn) : t('dayOf', { posted: fmt.day(l.postedOn), event: fmt.day(l.eventOn) })),
                },
                { key: 's', header: t('col.from'), cell: (l) => label(l.source) },
                { key: 'r', header: t('col.reference'), cell: (l) => l.reference ?? '—' },
                { key: 'u', header: t('col.unit'), cell: (l) => l.unitCode ?? '' },
                { key: 'm', header: t('col.memo'), cell: (l) => l.memo ?? '' },
                { key: 'dr', header: t('col.debit'), cell: (l) => (l.debit === '0.00' ? '' : money(fmt, l.debit)) },
                { key: 'cr', header: t('col.credit'), cell: (l) => (l.credit === '0.00' ? '' : money(fmt, l.credit)) },
                { key: 'b', header: t('col.balance'), cell: (l) => money(fmt, l.balance) },
              ]}
            />
            <div className="row" style={{ gap: 8, padding: 12 }}>
              <Button disabled={cursors.length < 2} onClick={() => setCursors((x) => x.slice(0, -1))}>
                {t('previous')}
              </Button>
              <Button
                disabled={!lines.data.nextCursor}
                onClick={() => lines.data?.nextCursor && setCursors((x) => [...x, lines.data!.nextCursor!])}
              >
                {c('next')}
              </Button>
            </div>
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
