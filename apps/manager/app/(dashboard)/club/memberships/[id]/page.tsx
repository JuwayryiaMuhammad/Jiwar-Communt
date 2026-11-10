'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { coverageBody, paidOnProblem, sameSelection, type PersonRef } from '@/components/club/logic';
import { PeoplePicker } from '@/components/club/people-picker';
import { Back } from '@/components/facilities/bits';
import { validMoney, validReceipt } from '@/components/facilities/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ClubMembershipDetail, type ClubPayment } from '@/lib/queries';
import clubAr from '@/messages/ar/money-club';
import ar from '@/messages/ar/money-club-memberships';
import clubEn from '@/messages/en/money-club';
import en from '@/messages/en/money-club-memberships';

const today = () => new Date().toLocaleDateString('en-CA');

function RecordPayment({ membership, onClose }: { membership: ClubMembershipDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const tc = useT(clubEn, clubAr);
  const c = useCommonT();
  const fmt = useFormat();
  const { locale } = useLocale();
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
        toast.show(t('paid', { from: fmt.day(p.periodStartsOn), to: fmt.day(p.periodEndsOn) }));
        onClose();
      },
    },
  );
  const problem = paidOnProblem(paidOn, today());
  const ready = planId !== '' && validMoney(amount) && validReceipt(receiptNumber) && !problem;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('payTitle', { unit: membership.unitCode })}
      description={t('payDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('recordPayment')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('plan')} error={fieldError(save.error, 'planId')}>
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
              <option value="">{c('select')}</option>
              {active.map((x) => (
                <option key={x.id} value={x.id}>
                  {locale === 'ar' ? x.nameAr : x.nameEn} · {fmt.money(x.price)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={t('amountPaid')}
          hint={plan ? t('planPrice', { price: fmt.money(plan.price) }) : undefined}
          error={fieldError(save.error, 'amount') ?? (amount && !validMoney(amount) ? t('moneyInvalid') : undefined)}
        >
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field
          label={t('receiptNumber')}
          hint={t('receiptHint')}
          error={fieldError(save.error, 'receiptNumber') ?? (receiptNumber && !validReceipt(receiptNumber) ? t('receiptInvalid') : undefined)}
        >
          {(p) => <Input {...p} maxLength={40} value={receiptNumber} onChange={(e) => setReceipt(e.target.value)} />}
        </Field>
        <Field label={t('paidOn')} error={fieldError(save.error, 'paidOn') ?? (problem ? tc(`paidOn.${problem}`) : undefined)}>
          {(p) => <Input {...p} type="date" max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Coverage({ membership }: { membership: ClubMembershipDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const saved: PersonRef[] = membership.people.map((p) => ({ kind: p.kind, id: p.id }));
  const [people, setPeople] = useState<PersonRef[]>(saved);
  const save = useAction(
    () => unwrap(api.PUT('/api/v1/staff/club-memberships/{id}/people', { params: { path: { id: membership.id } }, body: { people: coverageBody(people) } })),
    { invalidate: [keys.clubAll], onDone: () => toast.show(t('coverSaved')) },
  );
  const dirty = !sameSelection(people, saved);
  return (
    <Card flush>
      <CardHeader
        title={t('covers')}
        actions={
          <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            {c('save')}
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('club.billing');
  const membership = useQuery({ queryKey: keys.clubMembership(id), queryFn: () => fetchers.clubMembership(id), enabled: allowed });
  const plans = useQuery({ queryKey: keys.clubPlans, queryFn: fetchers.clubPlans, enabled: allowed });
  const planName = new Map((plans.data?.data ?? []).map((p) => [p.id, locale === 'ar' ? p.nameAr : p.nameEn]));
  const [paying, setPaying] = useState(false);
  const [reversing, setReversing] = useState<ClubPayment | null>(null);
  const reverse = useAction(
    (input: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/club-payments/{id}/reverse', { params: { path: { id: input.id } }, body: { reasonCode: input.reasonCode } })),
    {
      invalidate: [keys.clubAll],
      onDone: () => {
        toast.show(t('reversedToast'));
        setReversing(null);
      },
    },
  );
  const back = <Back href="/club/memberships" label={t('back')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('membership')} />
        <ForbiddenState />
      </>
    );
  const m = membership.data;

  return (
    <>
      <PageHeader
        back={back}
        title={m ? t('unitTitle', { unit: m.unitCode }) : t('membership')}
        description={
          m ? (
            <span className="row" style={{ gap: 8 }}>
              <StatusBadge status={m.state} />
              {m.activeThrough ? <span className="t-secondary">{t('activeThrough', { day: fmt.day(m.activeThrough) })}</span> : null}
            </span>
          ) : undefined
        }
        actions={
          m ? (
            <Button variant="primary" onClick={() => setPaying(true)}>
              {t('recordPayment')}
            </Button>
          ) : undefined
        }
      />
      <QueryState query={membership}>
        {m ? (
          <div className="stack">
            <Coverage key={m.people.map((p) => p.id).join('|')} membership={m} />
            <Card flush>
              <CardHeader title={t('payments')} />
              <DataTable<ClubPayment>
                rows={m.payments}
                rowKey={(p) => p.id}
                empty={t('noPayment')}
                columns={[
                  {
                    key: 'kind',
                    header: '',
                    cell: (p) =>
                      p.kind === 'reversal' ? (
                        <Badge tone="error">{t('payment.reversal')}</Badge>
                      ) : p.reversed ? (
                        <Badge tone="beige">{t('payment.reversed')}</Badge>
                      ) : (
                        <Badge tone="green">{t('payment.payment')}</Badge>
                      ),
                  },
                  { key: 'paid', header: t('col.paidOn'), cell: (p) => (p.paidOn ? fmt.day(p.paidOn) : fmt.date(p.createdAt)) },
                  { key: 'plan', header: t('col.plan'), cell: (p) => (p.planId ? (planName.get(p.planId) ?? '—') : label(p.reasonCode)) },
                  { key: 'amount', header: t('col.amount'), cell: (p) => fmt.money(p.amount) },
                  { key: 'receipt', header: t('col.receipt'), cell: (p) => <span className="t-mono">{p.receiptNumber ?? '—'}</span> },
                  {
                    key: 'period',
                    header: t('col.period'),
                    cell: (p) => (p.periodStartsOn ? t('period', { from: fmt.day(p.periodStartsOn), to: fmt.day(p.periodEndsOn) }) : '—'),
                  },
                  {
                    key: 'actions',
                    header: '',
                    className: 'table__actions',
                    cell: (p) =>
                      p.kind === 'payment' && !p.reversed ? (
                        <Button size="sm" onClick={() => setReversing(p)}>
                          {t('reverse')}
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
        title={t('reverseTitle', { receipt: reversing?.receiptNumber ?? '' })}
        description={t('reverseDescription')}
        codes={REASON_CODES.clubPaymentReverse}
        confirmLabel={t('reverse')}
        danger
        pending={reverse.isPending}
        error={<ErrorAlert error={reverse.error} />}
        onConfirm={(reasonCode) => reversing && reverse.mutate({ id: reversing.id, reasonCode })}
      />
    </>
  );
}
