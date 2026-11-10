'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
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
import { PayoutAccountField } from '@/components/finance/payout-account';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Disbursement } from '@/lib/queries';
import ar from '@/messages/ar/fin-payable-contracts';
import en from '@/messages/en/fin-payable-contracts';

const today = () => new Date().toLocaleDateString('en-CA');

function DisbursementActions({ d }: { d: Disbursement }) {
  const t = useT(en, ar);
  const toast = useToast();
  const { can } = usePermissions();
  const path = { params: { path: { id: d.id } } };
  const [key] = useState(() => crypto.randomUUID());
  const [rejecting, setRejecting] = useState(false);
  const [account, setAccount] = useState('');
  const approve = useAction(() => unwrap(api.POST('/api/v1/staff/finance/contract-disbursements/{id}/approve', path)), {
    invalidate: [keys.payablesAll],
    onDone: () => toast.show(t('approved', { number: d.number })),
  });
  const pay = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/contract-disbursements/{id}/pay', {
          params: { path: { id: d.id }, header: { 'Idempotency-Key': key } },
          body: { paidOn: today(), method: 'bank_transfer', ...(account ? { cashAccountId: account } : {}) },
        }),
      ),
    {
      invalidate: [keys.payablesAll, ['finance', 'cash-accounts']],
      onDone: (r) => toast.show(t('paid', { number: r.number, payout: r.payout?.number ?? '' })),
    },
  );
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/finance/contract-disbursements/{id}/reject', { ...path, body: { reasonCode } })),
    {
      invalidate: [keys.payablesAll],
      onDone: () => {
        toast.show(t('rejected', { number: d.number }));
        setRejecting(false);
      },
    },
  );
  return (
    <>
      <ErrorAlert error={approve.error ?? pay.error} />
      {d.status === 'requested' && can('finance.payables_approve') && !d.requestedByMe ? (
        <>
          <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate()}>
            {t('approve')}
          </Button>{' '}
          <Button size="sm" onClick={() => setRejecting(true)}>
            {t('turnDown')}
          </Button>
        </>
      ) : null}
      {d.status === 'approved' && can('finance.payables') ? (
        <>
          <PayoutAccountField method="bank_transfer" value={account} onChange={setAccount} error={pay.error} />
          <Button size="sm" loading={pay.isPending} disabled={!account} onClick={() => pay.mutate()}>
            {t('payToday')}
          </Button>
        </>
      ) : null}
      <ReasonCodeDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={t('rejectTitle', { number: d.number })}
        codes={REASON_CODES.disbursementReject}
        confirmLabel={t('turnDown')}
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => reject.mutate(code)}
      />
    </>
  );
}

function ContractMoney({ contractId }: { contractId: string }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: keys.contractPayables(contractId), queryFn: () => fetchers.contractPayables(contractId) });
  const [kind, setKind] = useState<'advance' | 'retention_release'>('advance');
  const [amount, setAmount] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const ask = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/contract-payables/{contractId}/disbursements', {
          params: { path: { contractId }, header: { 'Idempotency-Key': key } },
          body: { kind, amount: amount.trim() },
        }),
      ),
    { invalidate: [keys.payablesAll], onDone: (d) => toast.show(t('asked', { number: d.number })) },
  );
  const p = q.data;
  return (
    <QueryState query={q}>
      {p ? (
        <>
          <Card>
            <SectionHeader
              title={t('moneyTitle')}
              description={t('summary', {
                pct: p.retentionPct ? `${f.number(p.retentionPct)}%` : t('retentionNone'),
                held: f.money(p.retention.held),
                released: f.money(p.retention.released),
                open: f.money(p.retention.open),
                advPaid: f.money(p.advances.paid),
                advSetOff: f.money(p.advances.setOff),
                advOpen: f.money(p.advances.open),
                toPay: f.money(p.invoices.approved),
                paid: f.money(p.invoices.paid),
              })}
            />
            {can('finance.payables') ? (
              <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
                <Field label={t('askFor')}>
                  {(x) => (
                    <Select {...x} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                      <option value="advance">{t('advance')}</option>
                      <option value="retention_release">{t('release')}</option>
                    </Select>
                  )}
                </Field>
                <Field label={t('egp')} error={fieldError(ask.error, 'amount')}>
                  {(x) => <Input {...x} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
                </Field>
                <Button loading={ask.isPending} disabled={!amount.trim()} onClick={() => ask.mutate()}>
                  {t('ask')}
                </Button>
              </div>
            ) : null}
            <ErrorAlert error={ask.error} />
          </Card>
          <Card flush>
            <DataTable<Disbursement>
              rows={p.disbursements}
              rowKey={(d) => d.id}
              empty={t('noDisbursement')}
              columns={[
                { key: 'n', header: t('request'), cell: (d) => `${d.number} · ${label(d.kind)}` },
                { key: 'a', header: c('amount'), cell: (d) => f.money(d.amount) },
                { key: 's', header: c('status'), cell: (d) => label(d.status) },
                { key: 'x', header: '', cell: (d) => <DisbursementActions d={d} /> },
              ]}
            />
          </Card>
          <Card flush>
            <DataTable
              rows={p.guarantees}
              rowKey={(g) => g.id}
              empty={t('noGuarantee')}
              columns={[
                { key: 'k', header: t('guarantee'), cell: (g) => `${label(g.kind)} · ${g.issuer} ${g.reference}` },
                { key: 'a', header: c('amount'), cell: (g) => f.money(g.amount) },
                { key: 'e', header: t('expires'), cell: (g) => f.day(g.expiresOn) },
                { key: 's', header: c('status'), cell: (g) => label(g.status) },
              ]}
            />
          </Card>
        </>
      ) : null}
    </QueryState>
  );
}

/** A contract's advances, retention and guarantees (ADR 0089). */
export default function ContractPayablesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('finance.payables') || can('finance.payables_approve');
  const [contractId, setContractId] = useState('');
  const pending = useQuery({ queryKey: keys.disbursements, queryFn: fetchers.disbursements, enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Card flush>
        <CardHeader title={t('waiting')} />
        <QueryState query={pending}>
          <DataTable<Disbursement>
            rows={pending.data ?? []}
            rowKey={(d) => d.id}
            empty={t('waitingEmpty')}
            columns={[
              { key: 'n', header: t('request'), cell: (d) => `${d.number} · ${label(d.kind)}` },
              { key: 'a', header: c('amount'), cell: (d) => f.money(d.amount) },
              { key: 's', header: c('status'), cell: (d) => label(d.status) },
              {
                key: 'c',
                header: '',
                cell: (d) => (
                  <Button size="sm" onClick={() => setContractId(d.contractId)}>
                    {t('itsContract')}
                  </Button>
                ),
              },
              { key: 'x', header: '', cell: (d) => <DisbursementActions d={d} /> },
            ]}
          />
        </QueryState>
      </Card>
      <Field label={t('contractId')}>
        {(x) => <Input {...x} dir="ltr" value={contractId} onChange={(e) => setContractId(e.target.value.trim())} />}
      </Field>
      {/^[0-9a-f-]{36}$/.test(contractId) ? <ContractMoney contractId={contractId} /> : null}
    </>
  );
}
