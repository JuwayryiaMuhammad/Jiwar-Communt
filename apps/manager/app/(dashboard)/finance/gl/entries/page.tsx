'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { draftTotals, type DraftLine } from '@/components/finance/gl';
import { today } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/money-gl-entries';
import en from '@/messages/en/money-gl-entries';

type Manual = Schema<'GlManualEntryView'>;
type Entry = Schema<'GlEntryView'>;
type Status = '' | 'pending' | 'approved' | 'rejected' | 'withdrawn';

const TONE: Record<string, 'beige' | 'green' | 'terracotta' | 'dark'> = {
  pending: 'beige',
  approved: 'green',
  rejected: 'terracotta',
  withdrawn: 'dark',
};

/** An account's name in the page's language. */
function useAccountName() {
  const { locale } = useLocale();
  return (a: { nameEn: string; nameAr: string }) => (locale === 'ar' ? a.nameAr : a.nameEn);
}

/** A debit or credit amount as the ledger writes it, two decimals. */
function useAmount() {
  const f = useFormat();
  return (v: string) => f.number(v, { minimumFractionDigits: 2 });
}

function NewEntryDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const amountText = useAmount();
  const accountName = useAccountName();
  const toast = useToast();
  const chart = useQuery({ queryKey: keys.glChart(''), queryFn: () => fetchers.glChart() });
  const choices = (chart.data?.accounts ?? []).filter((a) => a.postable && !a.control);
  const [postedOn, setPostedOn] = useState(today());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { accountId: '', side: 'debit', amount: '' },
    { accountId: '', side: 'credit', amount: '' },
  ]);
  const totals = draftTotals(lines);
  const set = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const submit = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/gl/manual-entries', {
          body: {
            postedOn,
            memo,
            lines: lines.map((l) => ({ accountId: l.accountId, [l.side]: l.amount.trim() })),
          },
        }),
      ),
    {
      invalidate: [keys.glAll],
      onDone: (m) => {
        toast.show(t('submitted', { number: m.number }));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => totals.ready && memo.trim() && submit.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={submit.isPending} disabled={!totals.ready || !memo.trim()}>
            {t('submitForApproval')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('day')} error={fieldError(submit.error, 'postedOn')}>
          {(p) => <Input {...p} type="date" value={postedOn} onChange={(e) => setPostedOn(e.target.value)} />}
        </Field>
        <Field label={t('memo')} error={fieldError(submit.error, 'memo')}>
          {(p) => <Input {...p} value={memo} onChange={(e) => setMemo(e.target.value)} />}
        </Field>
        {lines.map((l, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <Select aria-label={t('account')} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}>
              <option value="">{t('accountPick')}</option>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {accountName(a)}
                </option>
              ))}
            </Select>
            <Select aria-label={t('side')} value={l.side} onChange={(e) => set(i, { side: e.target.value as DraftLine['side'] })}>
              <option value="debit">{t('side.debit')}</option>
              <option value="credit">{t('side.credit')}</option>
            </Select>
            <Input aria-label={c('amount')} inputMode="decimal" className="ltr" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} />
            {lines.length > 2 ? (
              <Button size="sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                {c('remove')}
              </Button>
            ) : null}
          </div>
        ))}
        <Button size="sm" onClick={() => setLines((ls) => [...ls, { accountId: '', side: 'debit', amount: '' }])}>
          {t('addLine')}
        </Button>
        <p className="t-muted">
          {t('totals', { debit: amountText(totals.debit), credit: amountText(totals.credit) })}
          {totals.ready ? '' : ` — ${t('mustAgree')}`}
        </p>
        <ErrorAlert error={submit.error} />
      </div>
    </Dialog>
  );
}

function ReverseDialog({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [postedOn, setPostedOn] = useState(today());
  const [memo, setMemo] = useState(t('reverseMemo', { reference: entry.reference ?? '' }).trim());
  const reverse = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/gl/entries/{id}/reverse', {
          params: { path: { id: entry.id } },
          body: { postedOn, memo },
        }),
      ),
    {
      invalidate: [keys.glAll],
      onDone: (m) => {
        toast.show(t('reverseQueued', { number: m.number }));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={entry.reference ? t('reverseTitle', { reference: entry.reference }) : t('reverseTheEntry')}
      description={t('reverseDescription')}
      onSubmit={() => reverse.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={reverse.isPending}>
            {t('writeReversal')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('day')} error={fieldError(reverse.error, 'postedOn')}>
          {(p) => <Input {...p} type="date" value={postedOn} onChange={(e) => setPostedOn(e.target.value)} />}
        </Field>
        <Field label={t('why')} error={fieldError(reverse.error, 'memo')}>
          {(p) => <Input {...p} value={memo} onChange={(e) => setMemo(e.target.value)} />}
        </Field>
        <ErrorAlert error={reverse.error} />
      </div>
    </Dialog>
  );
}

/**
 * Journal entries (ADR 0092): the manual entries with their approval — a
 * second person, never the maker — and the journal of a period, every
 * entry with its lines, a manual one reversible once.
 */
export default function JournalEntriesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const amountText = useAmount();
  const accountName = useAccountName();
  const { ready, can, me } = usePermissions();
  const allowed = can('finance.ledger');
  const write = can('finance.ledger_write');
  const toast = useToast();
  const [status, setStatus] = useState<Status>('pending');
  const [creating, setCreating] = useState(false);
  const [rejecting, setRejecting] = useState<Manual | null>(null);
  const [reversing, setReversing] = useState<Entry | null>(null);
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const manual = useQuery({ queryKey: keys.glManualEntries(status), queryFn: () => fetchers.glManualEntries(status), enabled: allowed });
  const journal = useCursorList(keys.glJournal(from, to), (cursor) => fetchers.glJournal(from, to, cursor), { enabled: allowed });
  const decide = useAction(
    ({ id, action }: { id: string; action: 'approve' | 'withdraw' }) =>
      action === 'approve'
        ? unwrap(api.POST('/api/v1/staff/finance/gl/manual-entries/{id}/approve', { params: { path: { id } } }))
        : unwrap(api.POST('/api/v1/staff/finance/gl/manual-entries/{id}/withdraw', { params: { path: { id } } })),
    {
      invalidate: [keys.glAll],
      onDone: (m, vars) => toast.show(t(vars.action === 'approve' ? 'approvedToast' : 'withdrawnToast', { number: m.number })),
    },
  );
  const reject = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/finance/gl/manual-entries/{id}/reject', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show(t('turnedDown'));
        setRejecting(null);
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
  const mine = (m: Manual) => m.createdBy.id === me?.id;
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          write ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('newManual')}
            </Button>
          ) : null
        }
      />
      <div className="stack">
        <ErrorAlert error={decide.error} />
        <Card flush>
          <SectionHeader title={t('manualTitle')} description={t('manualDescription')} />
          <div style={{ padding: 12 }}>
            <Select aria-label={c('status')} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              <option value="pending">{t('status.pending')}</option>
              <option value="approved">{t('status.approved')}</option>
              <option value="rejected">{t('status.rejected')}</option>
              <option value="withdrawn">{t('status.withdrawn')}</option>
              <option value="">{c('all')}</option>
            </Select>
          </div>
          <QueryState query={manual} rows={4}>
            <DataTable<Manual>
              rows={manual.data?.data}
              rowKey={(m) => m.id}
              empty={t('noManual')}
              columns={[
                { key: 'n', header: t('col.entry'), cell: (m) => <span className="ltr">{m.number}</span> },
                { key: 'd', header: t('col.day'), cell: (m) => f.day(m.postedOn) },
                { key: 'm', header: t('col.for'), cell: (m) => m.memo },
                {
                  key: 'l',
                  header: t('col.lines'),
                  cell: (m) =>
                    m.lines
                      .map((l) => `${l.code} ${l.debit !== '0.00' ? t('dr', { amount: amountText(l.debit) }) : t('cr', { amount: amountText(l.credit) })}`)
                      .join(' · '),
                },
                { key: 'b', header: c('by'), cell: (m) => m.createdBy.fullName ?? '—' },
                {
                  key: 's',
                  header: c('status'),
                  cell: (m) => (
                    <Badge tone={TONE[m.status]}>
                      {m.rejectReason ? t('statusReason', { status: t(`status.${m.status}`), reason: label(m.rejectReason) }) : t(`status.${m.status}`)}
                    </Badge>
                  ),
                },
                {
                  key: 'a',
                  header: '',
                  cell: (m) =>
                    write && m.status === 'pending' ? (
                      mine(m) ? (
                        <Button size="sm" onClick={() => decide.mutate({ id: m.id, action: 'withdraw' })}>
                          {t('withdraw')}
                        </Button>
                      ) : (
                        <span className="row" style={{ gap: 6 }}>
                          <Button size="sm" variant="primary" onClick={() => decide.mutate({ id: m.id, action: 'approve' })}>
                            {c('approve')}
                          </Button>
                          <Button size="sm" onClick={() => setRejecting(m)}>
                            {t('turnDown')}
                          </Button>
                        </span>
                      )
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
        <Card flush>
          <SectionHeader title={t('journalTitle')} description={t('journalDescription')} />
          <div className="row" style={{ gap: 8, padding: 12 }}>
            <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
          <QueryState query={journal} rows={6}>
            <DataTable<Entry>
              rows={journal.rows}
              rowKey={(e) => e.id}
              empty={t('noEntry')}
              columns={[
                { key: 'q', header: '#', cell: (e) => e.seq },
                { key: 'd', header: t('col.day'), cell: (e) => f.day(e.postedOn) },
                { key: 's', header: t('col.from'), cell: (e) => label(e.source) },
                { key: 'r', header: t('col.reference'), cell: (e) => (e.reference ? <span className="ltr">{e.reference}</span> : '—') },
                {
                  key: 'l',
                  header: t('col.lines'),
                  cell: (e) => (
                    <span>
                      {e.lines.map((l) => (
                        <span key={l.lineNo} style={{ display: 'block' }}>
                          {l.code} {accountName(l)}{' '}
                          <span className="t-mono">{l.debit !== '0.00' ? t('dr', { amount: amountText(l.debit) }) : t('cr', { amount: amountText(l.credit) })}</span>
                        </span>
                      ))}
                    </span>
                  ),
                },
                {
                  key: 'a',
                  header: '',
                  cell: (e) =>
                    write && e.source === 'manual' ? (
                      <Button size="sm" onClick={() => setReversing(e)}>
                        {t('reverse')}
                      </Button>
                    ) : null,
                },
              ]}
            />
            <LoadMore query={journal} />
          </QueryState>
        </Card>
      </div>
      {creating ? <NewEntryDialog onClose={() => setCreating(false)} /> : null}
      {reversing ? <ReverseDialog entry={reversing} onClose={() => setReversing(null)} /> : null}
      <ReasonCodeDialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={t('rejectTitle', { number: rejecting?.number ?? '' })}
        codes={REASON_CODES.glEntryReject}
        confirmLabel={t('turnDown')}
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(reasonCode) => rejecting && reject.mutate({ id: rejecting.id, reasonCode })}
      />
    </>
  );
}
