'use client';

import { fieldError, humanize, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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

type Manual = Schema<'GlManualEntryView'>;
type Entry = Schema<'GlEntryView'>;
type Status = '' | 'pending' | 'approved' | 'rejected' | 'withdrawn';

const money = (v: string) => <span className="t-mono">{v}</span>;
const TONE: Record<string, 'beige' | 'green' | 'terracotta' | 'dark'> = {
  pending: 'beige',
  approved: 'green',
  rejected: 'terracotta',
  withdrawn: 'dark',
};

function NewEntryDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const chart = useQuery({ queryKey: keys.glChart(''), queryFn: () => fetchers.glChart() });
  const choices = (chart.data?.accounts ?? []).filter((a) => a.postable && !a.control);
  const [postedOn, setPostedOn] = useState(today());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { accountId: '', side: 'debit', amount: '' },
    { accountId: '', side: 'credit', amount: '' },
  ]);
  const t = draftTotals(lines);
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
        toast.show(`${m.number} waits for a second person’s approval.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="A manual journal entry"
      description="It posts only once someone else who keeps the ledger approves it. Accounts a register keeps (bank and cash, receivables, unit credit, deposits, payables) are corrected in their register, not here."
      onSubmit={() => t.ready && memo.trim() && submit.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submit.isPending} disabled={!t.ready || !memo.trim()}>
            Submit for approval
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Day" error={fieldError(submit.error, 'postedOn')}>
          {(p) => <Input {...p} type="date" value={postedOn} onChange={(e) => setPostedOn(e.target.value)} />}
        </Field>
        <Field label="What it is for" error={fieldError(submit.error, 'memo')}>
          {(p) => <Input {...p} value={memo} onChange={(e) => setMemo(e.target.value)} />}
        </Field>
        {lines.map((l, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <Select aria-label="Account" value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}>
              <option value="">Account…</option>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.nameEn}
                </option>
              ))}
            </Select>
            <Select aria-label="Side" value={l.side} onChange={(e) => set(i, { side: e.target.value as DraftLine['side'] })}>
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
            </Select>
            <Input aria-label="Amount" inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} />
            {lines.length > 2 ? (
              <Button size="sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        <Button size="sm" onClick={() => setLines((ls) => [...ls, { accountId: '', side: 'debit', amount: '' }])}>
          Add a line
        </Button>
        <p className="t-muted">
          Debits {t.debit} · credits {t.credit}
          {t.ready ? '' : ' — they must agree'}
        </p>
        <ErrorAlert error={submit.error} />
      </div>
    </Dialog>
  );
}

function ReverseDialog({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const toast = useToast();
  const [postedOn, setPostedOn] = useState(today());
  const [memo, setMemo] = useState(`Reverses ${entry.reference ?? ''}`.trim());
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
        toast.show(`${m.number} waits for approval.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reverse ${entry.reference ?? 'the entry'}`}
      description="Its lines the other way round, on a day of an open month, for a second person’s approval."
      onSubmit={() => reverse.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={reverse.isPending}>
            Write the reversal
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Day" error={fieldError(reverse.error, 'postedOn')}>
          {(p) => <Input {...p} type="date" value={postedOn} onChange={(e) => setPostedOn(e.target.value)} />}
        </Field>
        <Field label="Why" error={fieldError(reverse.error, 'memo')}>
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
  const journal = useQuery({ queryKey: keys.glJournal(from, to, ''), queryFn: () => fetchers.glJournal(from, to), enabled: allowed });
  const decide = useAction(
    ({ id, action }: { id: string; action: 'approve' | 'withdraw' }) =>
      action === 'approve'
        ? unwrap(api.POST('/api/v1/staff/finance/gl/manual-entries/{id}/approve', { params: { path: { id } } }))
        : unwrap(api.POST('/api/v1/staff/finance/gl/manual-entries/{id}/withdraw', { params: { path: { id } } })),
    { invalidate: [keys.glAll], onDone: (m) => toast.show(`${m.number}: ${m.status}.`) },
  );
  const reject = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/finance/gl/manual-entries/{id}/reject', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.glAll],
      onDone: () => {
        toast.show('Turned down.');
        setRejecting(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Journal entries" />
        <ForbiddenState />
      </>
    );
  const mine = (m: Manual) => m.createdBy.id === me?.id;
  return (
    <>
      <PageHeader
        title="Journal entries"
        description="Every money event posts its own entry. A manual entry takes effect once a second person approves it."
        actions={
          write ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New manual entry
            </Button>
          ) : null
        }
      />
      <div className="stack">
        <ErrorAlert error={decide.error} />
        <Card flush>
          <SectionHeader
            title="Manual entries"
            description="Approved by someone other than whoever wrote them."
          />
          <div style={{ padding: 12 }}>
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              <option value="pending">Waiting</option>
              <option value="approved">Approved</option>
              <option value="rejected">Turned down</option>
              <option value="withdrawn">Withdrawn</option>
              <option value="">All</option>
            </Select>
          </div>
          <QueryState query={manual} rows={4}>
            <DataTable<Manual>
              rows={manual.data?.data}
              rowKey={(m) => m.id}
              empty="No manual entry"
              columns={[
                { key: 'n', header: 'Entry', cell: (m) => m.number },
                { key: 'd', header: 'Day', cell: (m) => m.postedOn },
                { key: 'm', header: 'For', cell: (m) => m.memo },
                {
                  key: 'l',
                  header: 'Lines',
                  cell: (m) =>
                    m.lines.map((l) => `${l.code} ${l.debit !== '0.00' ? `Dr ${l.debit}` : `Cr ${l.credit}`}`).join(' · '),
                },
                { key: 'b', header: 'By', cell: (m) => m.createdBy.fullName ?? '—' },
                {
                  key: 's',
                  header: 'Status',
                  cell: (m) => <Badge tone={TONE[m.status]}>{m.rejectReason ? `${m.status}: ${humanize(m.rejectReason)}` : m.status}</Badge>,
                },
                {
                  key: 'a',
                  header: '',
                  cell: (m) =>
                    write && m.status === 'pending' ? (
                      mine(m) ? (
                        <Button size="sm" onClick={() => decide.mutate({ id: m.id, action: 'withdraw' })}>
                          Withdraw
                        </Button>
                      ) : (
                        <span className="row" style={{ gap: 6 }}>
                          <Button size="sm" variant="primary" onClick={() => decide.mutate({ id: m.id, action: 'approve' })}>
                            Approve
                          </Button>
                          <Button size="sm" onClick={() => setRejecting(m)}>
                            Turn down
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
          <SectionHeader title="The journal" description="Every entry of the period, in order, with its lines." />
          <div className="row" style={{ gap: 8, padding: 12 }}>
            <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
          <QueryState query={journal} rows={6}>
            <DataTable<Entry>
              rows={journal.data?.data}
              rowKey={(e) => e.id}
              empty="No entry in this period"
              columns={[
                { key: 'q', header: '#', cell: (e) => e.seq },
                { key: 'd', header: 'Day', cell: (e) => e.postedOn },
                { key: 's', header: 'From', cell: (e) => humanize(e.source) },
                { key: 'r', header: 'Reference', cell: (e) => e.reference ?? '—' },
                {
                  key: 'l',
                  header: 'Lines',
                  cell: (e) => (
                    <span>
                      {e.lines.map((l) => (
                        <span key={l.lineNo} style={{ display: 'block' }}>
                          {l.code} {l.nameEn} {l.debit !== '0.00' ? <>Dr {money(l.debit)}</> : <>Cr {money(l.credit)}</>}
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
                        Reverse
                      </Button>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
      </div>
      {creating ? <NewEntryDialog onClose={() => setCreating(false)} /> : null}
      {reversing ? <ReverseDialog entry={reversing} onClose={() => setReversing(null)} /> : null}
      <ReasonCodeDialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={`Turn down ${rejecting?.number ?? ''}`}
        codes={REASON_CODES.glEntryReject}
        confirmLabel="Turn down"
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(reasonCode) => rejecting && reject.mutate({ id: rejecting.id, reasonCode })}
      />
    </>
  );
}
