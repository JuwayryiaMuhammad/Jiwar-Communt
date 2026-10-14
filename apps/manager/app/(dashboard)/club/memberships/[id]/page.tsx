'use client';

import { fieldError, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { coverageBody, egp, paidOnProblem, sameSelection, type PersonRef } from '@/components/club/logic';
import { PeoplePicker } from '@/components/club/people-picker';
import { Back } from '@/components/facilities/bits';
import { validMoney, validReceipt } from '@/components/facilities/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ClubMembershipDetail, type ClubPayment } from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');

function RecordPayment({ membership, onClose }: { membership: ClubMembershipDetail; onClose: () => void }) {
  const toast = useToast();
  const plans = useQuery({ queryKey: keys.clubPlans, queryFn: fetchers.clubPlans });
  const active = (plans.data?.data ?? []).filter((p) => p.active);
  const [planId, setPlanId] = useState('');
  const [amount, setAmount] = useState('');
  const [receiptNumber, setReceipt] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const plan = active.find((p) => p.id === planId);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/club-memberships/{id}/payments', {
          params: { path: { id: membership.id } },
          body: { planId, amount: amount.trim(), currency: 'EGP', receiptNumber: receiptNumber.trim(), paidOn },
        }),
      ),
    {
      invalidate: [keys.clubAll],
      onDone: (p) => {
        toast.show(`Recorded. It pays from ${p.periodStartsOn} to the day before ${p.periodEndsOn}.`);
        onClose();
      },
    },
  );
  const dateProblem = paidOnProblem(paidOn, today());
  const ready = planId !== '' && validMoney(amount) && validReceipt(receiptNumber) && !dateProblem;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Record a payment · unit ${membership.unitCode}`}
      description="A payment made at the office. It pays for a period of the plan from the day it was paid, or from where the last period paid for ends. Records are never edited: a wrong one is reversed."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Plan" error={fieldError(save.error, 'planId')}>
          {(p) => (
            <Select
              {...p}
              value={planId}
              onChange={(e) => {
                setPlanId(e.target.value);
                const picked = active.find((x) => x.id === e.target.value);
                if (picked && !amount) setAmount(picked.price);
              }}
            >
              <option value="">Select…</option>
              {active.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.nameEn} · {egp(x.price)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Amount paid, EGP" hint={plan ? `The plan’s price is ${egp(plan.price)}.` : undefined} error={fieldError(save.error, 'amount') ?? (amount && !validMoney(amount) ? 'Up to two decimals, more than zero.' : undefined)}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Receipt number" hint="Recorded once in the compound." error={fieldError(save.error, 'receiptNumber') ?? (receiptNumber && !validReceipt(receiptNumber) ? 'Letters, digits, / and - only.' : undefined)}>
          {(p) => <Input {...p} maxLength={40} value={receiptNumber} onChange={(e) => setReceipt(e.target.value)} />}
        </Field>
        <Field label="Paid on" error={fieldError(save.error, 'paidOn') ?? dateProblem}>
          {(p) => <Input {...p} type="date" max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Coverage({ membership }: { membership: ClubMembershipDetail }) {
  const toast = useToast();
  const saved: PersonRef[] = membership.people.map((p) => ({ kind: p.kind, id: p.id }));
  const [people, setPeople] = useState<PersonRef[]>(saved);
  const save = useAction(
    () => unwrap(api.PUT('/api/v1/staff/club-memberships/{id}/people', { params: { path: { id: membership.id } }, body: { people: coverageBody(people) } })),
    { invalidate: [keys.clubAll], onDone: () => toast.show('Saved: whom it covers.') },
  );
  const dirty = !sameSelection(people, saved);
  return (
    <Card flush>
      <CardHeader
        title="Whom it covers"
        actions={
          <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        }
      />
      <CardBody>
        <div className="stack">
          <PeoplePicker unitId={membership.unitId} value={people} onChange={setPeople} />
          <ErrorAlert error={save.error} />
        </div>
      </CardBody>
    </Card>
  );
}

/** A unit's membership, for the accountant (ADR 0044): whom it covers and its ledger. */
export default function ClubMembershipPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('club.billing');
  const membership = useQuery({ queryKey: keys.clubMembership(id), queryFn: () => fetchers.clubMembership(id), enabled: allowed });
  const plans = useQuery({ queryKey: keys.clubPlans, queryFn: fetchers.clubPlans, enabled: allowed });
  const planName = new Map((plans.data?.data ?? []).map((p) => [p.id, p.nameEn]));
  const [paying, setPaying] = useState(false);
  const [reversing, setReversing] = useState<ClubPayment | null>(null);
  const reverse = useAction(
    (input: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/club-payments/{id}/reverse', { params: { path: { id: input.id } }, body: { reasonCode: input.reasonCode } })),
    {
      invalidate: [keys.clubAll],
      onDone: () => {
        toast.show('Reversed. The period it paid for no longer counts.');
        setReversing(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/club/memberships" label="Memberships" />} title="Membership" />
        <ForbiddenState />
      </>
    );
  const m = membership.data;

  return (
    <>
      <PageHeader
        back={<Back href="/club/memberships" label="Memberships" />}
        title={m ? `Unit ${m.unitCode}` : 'Membership'}
        description={
          m ? (
            <span className="row" style={{ gap: 8 }}>
              <StatusBadge status={m.state} />
              {m.activeThrough ? <span className="t-secondary">Active through {m.activeThrough}</span> : null}
            </span>
          ) : undefined
        }
        actions={
          m ? (
            <Button variant="primary" onClick={() => setPaying(true)}>
              Record payment
            </Button>
          ) : undefined
        }
      />
      <QueryState query={membership}>
        {m ? (
          <div className="stack">
            <Coverage key={m.people.map((p) => p.id).join('|')} membership={m} />
            <Card flush>
              <CardHeader title="Payments" />
              <DataTable<ClubPayment>
                rows={m.payments}
                rowKey={(p) => p.id}
                empty="No payment yet"
                columns={[
                  {
                    key: 'kind',
                    header: '',
                    cell: (p) =>
                      p.kind === 'reversal' ? <Badge tone="error">Reversal</Badge> : p.reversed ? <Badge tone="beige">Reversed</Badge> : <Badge tone="green">Payment</Badge>,
                  },
                  { key: 'paid', header: 'Paid on', cell: (p) => p.paidOn ?? new Date(p.createdAt).toLocaleDateString('en-CA') },
                  { key: 'plan', header: 'Plan', cell: (p) => (p.planId ? (planName.get(p.planId) ?? '—') : humanize(p.reasonCode)) },
                  { key: 'amount', header: 'Amount', cell: (p) => egp(p.amount) },
                  { key: 'receipt', header: 'Receipt', cell: (p) => <span className="t-mono">{p.receiptNumber ?? '—'}</span> },
                  {
                    key: 'period',
                    header: 'Pays for',
                    cell: (p) => (p.periodStartsOn ? `${p.periodStartsOn} → ${p.periodEndsOn}` : '—'),
                  },
                  {
                    key: 'actions',
                    header: '',
                    className: 'table__actions',
                    cell: (p) =>
                      p.kind === 'payment' && !p.reversed ? (
                        <Button size="sm" onClick={() => setReversing(p)}>
                          Reverse
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </QueryState>
      {paying && m ? <RecordPayment membership={m} onClose={() => setPaying(false)} /> : null}
      <ReasonCodeDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        title={`Reverse receipt ${reversing?.receiptNumber ?? ''}?`}
        description="A new record cancels this one; nothing is edited. The period it paid for no longer counts."
        codes={REASON_CODES.clubPaymentReverse}
        confirmLabel="Reverse"
        danger
        pending={reverse.isPending}
        error={<ErrorAlert error={reverse.error} />}
        onConfirm={(reasonCode) => reversing && reverse.mutate({ id: reversing.id, reasonCode })}
      />
    </>
  );
}
