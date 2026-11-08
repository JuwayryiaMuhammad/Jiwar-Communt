'use client';

import { fieldError, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Summary = Schema<'CustodySummaryView'>;
type Handin = Schema<'CustodyHandinView'>;
type Investigation = Schema<'CustodyInvestigationView'>;
const KEY = ['finance', 'custody'] as const;
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');
const COUNT = /^\d{1,8}(\.\d{1,2})?$/;

/** The receiver counts the cash against what the custodian holds now. */
function HandIn({ custodian, onClose }: { custodian: Summary; onClose: () => void }) {
  const toast = useToast();
  const boxes = useQuery({ queryKey: ['finance', 'cash-accounts'], queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cash-accounts')) });
  const [box, setBox] = useState('');
  const [counted, setCounted] = useState(custodian.expected);
  const [reason, setReason] = useState('');
  const differs = COUNT.test(counted.trim()) && Number(counted) !== Number(custodian.expected);
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/custody/{accountId}/handins', {
          params: { path: { accountId: custodian.custodian.id } },
          body: { cashAccountId: box, expected: custodian.expected, counted: counted.trim(), ...(differs ? { varianceReason: reason } : {}) },
        }),
      ),
    {
      invalidate: [KEY, ['finance', 'cash-accounts']],
      onDone: () => {
        toast.show(differs ? 'Handed in with a variance: the manager is told.' : 'Handed in.');
        onClose();
      },
    },
  );
  const ok = box && COUNT.test(counted.trim()) && (!differs || reason);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Cash from ${custodian.custodian.fullName ?? 'a staff member'}`}
      description={`${custodian.openCount} payment(s), ${custodian.expected} EGP expected. If a payment lands meanwhile, count again.`}
      onSubmit={() => ok && record.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={record.isPending} disabled={!ok}>
            Record the hand-in
          </Button>
        </>
      }
    >
      <QueryState query={boxes}>
        <div className="form">
          <Field label="Into the cash box" error={fieldError(record.error, 'cashAccountId')}>
            {(p) => (
              <Select {...p} value={box} onChange={(e) => setBox(e.target.value)}>
                <option value="">Choose…</option>
                {boxes.data?.data
                  .filter((a) => a.kind === 'cash')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Counted, EGP" error={fieldError(record.error, 'counted')}>
            {(p) => <Input {...p} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />}
          </Field>
          {differs ? (
            <Field label="Why it differs" error={fieldError(record.error, 'varianceReason')}>
              {(p) => (
                <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">Choose…</option>
                  {REASON_CODES.custodyVariance.map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <ErrorAlert error={record.error} />
        </div>
      </QueryState>
    </Dialog>
  );
}

/** Settles a variance: directly, or as an investigation's decision. */
function Settle({ handin, investigation, onClose }: { handin?: Handin; investigation?: Investigation; onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [recovered, setRecovered] = useState('');
  const body = { reasonCode: code, ...(code === 'recovered' ? { recoveredAmount: recovered.trim() } : {}) };
  // A hand-in's view or an investigation's: the toast reads neither.
  const settle = useAction<void, unknown>(
    () =>
      investigation
        ? unwrap(api.POST('/api/v1/staff/finance/custody-investigations/{id}/decide', { params: { path: { id: investigation.id } }, body }))
        : unwrap(api.POST('/api/v1/staff/finance/custody-handins/{id}/resolve', { params: { path: { id: handin!.id } }, body })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Settled.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Settle ${investigation?.handinNumber ?? handin?.number}`}
      onSubmit={() => code && settle.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={settle.isPending} disabled={!code}>
            Settle
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Outcome" error={fieldError(settle.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Choose…</option>
              {REASON_CODES.custodyOutcome.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {code === 'recovered' ? (
          <Field label="Recovered, EGP" hint="Cash recovered of the shortage, into the hand-in’s box." error={fieldError(settle.error, 'recoveredAmount')}>
            {(p) => <Input {...p} inputMode="decimal" value={recovered} onChange={(e) => setRecovered(e.target.value)} />}
          </Field>
        ) : null}
        <ErrorAlert error={settle.error} />
      </div>
    </Dialog>
  );
}

function Investigate({ handin, onClose }: { handin: Handin; onClose: () => void }) {
  const toast = useToast();
  const staff = useQuery({ queryKey: ['accounts', 'staff'], queryFn: () => unwrap(api.GET('/api/v1/accounts', { params: { query: { limit: 100 } } })) });
  const [owner, setOwner] = useState('');
  const [dueOn, setDueOn] = useState('');
  const open = useAction(
    () => unwrap(api.POST('/api/v1/staff/finance/custody-handins/{id}/investigation', { params: { path: { id: handin.id } }, body: { ownerId: owner, dueOn } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Investigation opened: its owner is told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Investigate ${handin.number}`}
      description="The owner holds finance.custody or finance.payments and is not the custodian."
      onSubmit={() => owner && dueOn && open.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={open.isPending} disabled={!owner || !dueOn}>
            Open
          </Button>
        </>
      }
    >
      <QueryState query={staff}>
        <div className="form">
          <Field label="Owner" error={fieldError(open.error, 'ownerId')}>
            {(p) => (
              <Select {...p} value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">Choose…</option>
                {staff.data?.data
                  .filter((a) => 'type' in a && (a.type === 'staff' || a.type === 'manager') && a.id !== handin.custodian.id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {'fullName' in a ? a.fullName : a.id}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Due" hint="Within 60 days." error={fieldError(open.error, 'dueOn')}>
            {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
          </Field>
          <ErrorAlert error={open.error} />
        </div>
      </QueryState>
    </Dialog>
  );
}

/**
 * Custody (ADR 0085, C1): the office cash each collector or cashier
 * recorded and has not handed in; hand-ins counted against it; variances
 * settled by the manager or through an investigation.
 */
export default function CustodyPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.payments') || can('finance.custody');
  const keeper = can('finance.custody');
  const summary = useQuery({ queryKey: [...KEY, 'summary'], queryFn: () => unwrap(api.GET('/api/v1/staff/finance/custody')), enabled: can('finance.payments') });
  const variances = useQuery({
    queryKey: [...KEY, 'variances'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/custody-handins', { params: { query: { status: 'variance' } } })),
    enabled: can('finance.payments'),
  });
  const investigations = useQuery({
    queryKey: [...KEY, 'investigations'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/custody-investigations', { params: { query: { status: 'open' } } })),
    enabled: allowed,
  });
  const [handing, setHanding] = useState<Summary | null>(null);
  const [settling, setSettling] = useState<{ handin?: Handin; investigation?: Investigation } | null>(null);
  const [investigating, setInvestigating] = useState<Handin | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Custody" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Custody" description="Cash collected at the office or in the field, until it is handed in." />
      <div className="stack">
        <Card flush>
          <CardHeader title="Not handed in" />
          <QueryState query={summary}>
            <DataTable<Summary>
              rows={summary.data?.data}
              rowKey={(r) => r.custodian.id}
              empty="Everyone has handed in"
              columns={[
                { key: 'w', header: 'Who', cell: (r) => r.custodian.fullName ?? '—' },
                { key: 'n', header: 'Payments', cell: (r) => r.openCount },
                { key: 'e', header: 'Expected', cell: (r) => <span className="t-mono">{r.expected} EGP</span> },
                { key: 'a', header: 'Oldest', cell: (r) => (r.ageHours === null ? '—' : <Badge tone={r.ageHours >= 24 ? 'error' : 'beige'}>{`${r.ageHours} h`}</Badge>) },
                { key: 'v', header: 'Variances open', cell: (r) => r.unresolvedVariances || '—' },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (r) =>
                    r.openCount ? (
                      <Button size="sm" variant="primary" onClick={() => setHanding(r)}>
                        Hand in
                      </Button>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
        <Card flush>
          <CardHeader title="Variances to settle" />
          <QueryState query={variances}>
            <DataTable<Handin>
              rows={variances.data?.data}
              rowKey={(r) => r.id}
              empty="None"
              columns={[
                { key: 'n', header: 'Hand-in', cell: (r) => <span className="t-mono">{r.number}</span> },
                { key: 'c', header: 'Custodian', cell: (r) => r.custodian.fullName ?? '—' },
                { key: 'v', header: 'Variance', cell: (r) => <span className="t-mono">{r.variance} EGP</span> },
                { key: 'r', header: 'Why', cell: (r) => (r.varianceReason ? label(r.varianceReason) : '—') },
                { key: 'd', header: 'Counted', cell: (r) => formatDateTime(r.createdAt) },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (r) =>
                    keeper && !r.investigationId ? (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <Button size="sm" onClick={() => setInvestigating(r)}>
                          Investigate
                        </Button>
                        <Button size="sm" variant="primary" onClick={() => setSettling({ handin: r })}>
                          Settle
                        </Button>
                      </span>
                    ) : r.investigationId ? (
                      <Badge tone="beige">Investigating</Badge>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
        <Card flush>
          <CardHeader title="Open investigations" />
          <QueryState query={investigations}>
            <DataTable<Investigation>
              rows={investigations.data?.data}
              rowKey={(r) => r.id}
              empty="None"
              columns={[
                { key: 'n', header: 'Hand-in', cell: (r) => <span className="t-mono">{r.handinNumber}</span> },
                { key: 'o', header: 'Owner', cell: (r) => r.owner.fullName ?? '—' },
                { key: 'd', header: 'Due', cell: (r) => (r.overdue ? <Badge tone="error">{r.dueOn}</Badge> : r.dueOn) },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (r) => (
                    <Button size="sm" variant="primary" onClick={() => setSettling({ investigation: r })}>
                      Decide
                    </Button>
                  ),
                },
              ]}
            />
          </QueryState>
        </Card>
      </div>
      {handing ? <HandIn custodian={handing} onClose={() => setHanding(null)} /> : null}
      {settling ? <Settle {...settling} onClose={() => setSettling(null)} /> : null}
      {investigating ? <Investigate handin={investigating} onClose={() => setInvestigating(null)} /> : null}
    </>
  );
}
