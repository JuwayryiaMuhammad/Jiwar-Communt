'use client';

import { fieldError, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { validMoney } from '@/components/finance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type PlanRequest = Schema<'PlanRequestView'>;
type Status = PlanRequest['status'];
const KEY = ['finance', 'plan-requests'] as const;
const SETTINGS = ['finance', 'plan-settings'] as const;
const STATUSES: { value: Status; label: string }[] = [
  { value: 'pending', label: 'Waiting' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'declined', label: 'Declined' },
  { value: 'withdrawn', label: 'Withdrawn' },
  { value: 'lapsed', label: 'Lapsed' },
];
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');

/** `n` monthly instalments of what the invoice owes, from a month on; the last takes the rest. */
function schedule(outstanding: string, n: number): { dueOn: string; amount: string }[] {
  const cents = Math.round(Number(outstanding) * 100);
  const each = Math.floor(cents / n);
  const first = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(first.getFullYear(), first.getMonth() + i + 1, first.getDate());
    const amount = i === n - 1 ? cents - each * (n - 1) : each;
    return { dueOn: d.toLocaleDateString('en-CA'), amount: (amount / 100).toFixed(2) };
  });
}

function Accept({ request, onClose }: { request: PlanRequest; onClose: () => void }) {
  const toast = useToast();
  const invoice = useQuery({
    queryKey: ['finance', 'invoices', request.invoiceId],
    queryFn: () => unwrap(api.GET('/api/v1/staff/invoices/{id}', { params: { path: { id: request.invoiceId } } })),
  });
  const [rows, setRows] = useState<{ dueOn: string; amount: string }[]>([]);
  useEffect(() => {
    if (invoice.data) setRows(schedule(invoice.data.outstanding, request.months));
  }, [invoice.data, request.months]);
  const accept = useAction(
    () => unwrap(api.POST('/api/v1/staff/plan-requests/{id}/accept', { params: { path: { id: request.id } }, body: { instalments: rows } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(`${request.invoiceNumber} is now a plan of ${rows.length} instalments.`);
        onClose();
      },
    },
  );
  const ready = rows.length >= 2 && rows.every((r) => validMoney(r.amount) && /^\d{4}-\d{2}-\d{2}$/.test(r.dueOn));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Accept the plan on ${request.invoiceNumber}`}
      description={`Asked over ${request.months} months. The instalments must add up to what the invoice owes now, as when you split it yourself.`}
      onSubmit={() => ready && accept.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={accept.isPending} disabled={!ready}>
            Accept
          </Button>
        </>
      }
    >
      <QueryState query={invoice}>
        <div className="form">
          <p className="t-secondary">Owed now: {invoice.data?.outstanding} EGP</p>
          {rows.map((r, i) => (
            <div className="row" key={i} style={{ gap: 8 }}>
              <Field label={`Instalment ${i + 1}, due`} error={fieldError(accept.error, `instalments.${i}.dueOn`)}>
                {(p) => <Input {...p} type="date" value={r.dueOn} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)))} />}
              </Field>
              <Field label="EGP" error={fieldError(accept.error, `instalments.${i}.amount`)}>
                {(p) => <Input {...p} inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />}
              </Field>
            </div>
          ))}
          <ErrorAlert error={accept.error} />
        </div>
      </QueryState>
    </Dialog>
  );
}

function Decline({ request, onClose }: { request: PlanRequest; onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const decline = useAction(
    () => unwrap(api.POST('/api/v1/staff/plan-requests/{id}/decline', { params: { path: { id: request.id } }, body: { reasonCode: code } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Declined: the resident is told why, by its code.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Decline the plan on ${request.invoiceNumber}`}
      onSubmit={() => code && decline.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={decline.isPending} disabled={!code}>
            Decline
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Why" error={fieldError(decline.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Choose…</option>
              {REASON_CODES.planRequestDecline.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={decline.error} />
      </div>
    </Dialog>
  );
}

/** How the compound helps residents plan their payments (ADR 0069). */
function Terms() {
  const toast = useToast();
  const settings = useQuery({ queryKey: SETTINGS, queryFn: () => unwrap(api.GET('/api/v1/staff/finance/plan-settings')) });
  const [months, setMonths] = useState('');
  const [floor, setFloor] = useState('');
  const [dues, setDues] = useState(false);
  useEffect(() => {
    if (!settings.data) return;
    setMonths(String(settings.data.planMaxMonths));
    setFloor(settings.data.planOfferMinAmount ?? '');
    setDues(settings.data.duesNotice);
  }, [settings.data]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/finance/plan-settings', {
          body: { planMaxMonths: Number(months), planOfferMinAmount: floor.trim() === '' ? null : floor.trim(), duesNotice: dues },
        }),
      ),
    { invalidate: [SETTINGS], onDone: () => toast.show('Saved: from the next request and notice on.') },
  );
  const n = Number(months);
  const valid = Number.isInteger(n) && n >= 2 && n <= 24 && (floor.trim() === '' || validMoney(floor));
  return (
    <Card>
      <CardHeader title="Terms for residents" />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field label="The most months a resident may ask for" hint="2 to 24." error={fieldError(save.error, 'planMaxMonths')}>
              {(p) => <Input {...p} type="number" min={2} max={24} value={months} onChange={(e) => setMonths(e.target.value)} />}
            </Field>
            <Field
              label="Offer a plan from, EGP"
              hint="An invoice that still owes at least this is offered a plan with its due-soon notice. Empty: never."
              error={fieldError(save.error, 'planOfferMinAmount')}
            >
              {(p) => <Input {...p} inputMode="decimal" value={floor} onChange={(e) => setFloor(e.target.value)} />}
            </Field>
            <Checkbox label="Tell a unit when its next month’s dues are far above the months before" checked={dues} onChange={(e) => setDues(e.target.checked)} />
            <div>
              <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
                Save
              </Button>
            </div>
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

/**
 * Payment plans residents ask for (ADR 0069): accepted with the
 * instalments the staff set — the same split as their own — or declined
 * with a reason code. A waiting one on an invoice paid meanwhile lapses.
 */
export default function PlanRequestsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const [status, setStatus] = useState<Status>('pending');
  const list = useQuery({
    queryKey: [...KEY, status],
    queryFn: () => unwrap(api.GET('/api/v1/staff/plan-requests', { params: { query: { status } } })),
    enabled: allowed,
  });
  const [accepting, setAccepting] = useState<PlanRequest | null>(null);
  const [declining, setDeclining] = useState<PlanRequest | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Plan requests" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Plan requests" description="Payment plans residents asked for on invoices they owe." />
      <div className="stack">
        <Segmented label="Status" value={status} onChange={setStatus} options={STATUSES} />
        <Card flush>
          <QueryState query={list}>
            <DataTable<PlanRequest>
              rows={list.data?.data}
              rowKey={(r) => r.id}
              empty="None"
              columns={[
                { key: 'i', header: 'Invoice', cell: (r) => <span className="t-mono">{r.invoiceNumber}</span> },
                { key: 'm', header: 'Months asked', cell: (r) => r.months },
                { key: 's', header: 'Status', cell: (r) => <Badge tone={r.status === 'pending' ? 'terracotta' : 'beige'}>{label(r.status)}</Badge> },
                { key: 'c', header: 'Asked', cell: (r) => formatDateTime(r.createdAt) },
                {
                  key: 'a',
                  header: '',
                  className: 'table__actions',
                  cell: (r) =>
                    r.status === 'pending' ? (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <Button size="sm" variant="primary" onClick={() => setAccepting(r)}>
                          Accept
                        </Button>
                        <Button size="sm" onClick={() => setDeclining(r)}>
                          Decline
                        </Button>
                      </span>
                    ) : r.declineReason ? (
                      label(r.declineReason)
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
        <Terms />
      </div>
      {accepting ? <Accept request={accepting} onClose={() => setAccepting(null)} /> : null}
      {declining ? <Decline request={declining} onClose={() => setDeclining(null)} /> : null}
    </>
  );
}
