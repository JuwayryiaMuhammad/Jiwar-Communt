'use client';

import { fieldError, formatDate, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Disbursement } from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');

function DisbursementActions({ d }: { d: Disbursement }) {
  const toast = useToast();
  const { can } = usePermissions();
  const path = { params: { path: { id: d.id } } };
  const [key] = useState(() => crypto.randomUUID());
  const [rejecting, setRejecting] = useState(false);
  const approve = useAction(() => unwrap(api.POST('/api/v1/staff/finance/contract-disbursements/{id}/approve', path)), {
    invalidate: [keys.payablesAll],
    onDone: () => toast.show(`${d.number} is approved.`),
  });
  const pay = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/contract-disbursements/{id}/pay', {
          params: { path: { id: d.id }, header: { 'Idempotency-Key': key } },
          body: { paidOn: today(), method: 'bank_transfer' },
        }),
      ),
    { invalidate: [keys.payablesAll], onDone: (r) => toast.show(`${r.number} is paid as ${r.payout?.number}.`) },
  );
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/finance/contract-disbursements/{id}/reject', { ...path, body: { reasonCode } })),
    {
      invalidate: [keys.payablesAll],
      onDone: () => {
        toast.show(`${d.number} is turned down.`);
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
            Approve
          </Button>{' '}
          <Button size="sm" onClick={() => setRejecting(true)}>
            Turn down
          </Button>
        </>
      ) : null}
      {d.status === 'approved' && can('finance.payables') ? (
        <Button size="sm" loading={pay.isPending} onClick={() => pay.mutate()}>
          Pay today
        </Button>
      ) : null}
      <ReasonCodeDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={`Turn down ${d.number}?`}
        codes={REASON_CODES.disbursementReject}
        confirmLabel="Turn down"
        danger
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => reject.mutate(code)}
      />
    </>
  );
}

function ContractMoney({ contractId }: { contractId: string }) {
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
    { invalidate: [keys.payablesAll], onDone: (d) => toast.show(`Asked as ${d.number}; the approvers were told.`) },
  );
  const p = q.data;
  return (
    <QueryState query={q}>
      {p ? (
        <>
          <Card>
            <CardHeader
              title="The contract’s money"
              description={`Retention ${p.retentionPct ? `${p.retentionPct}%` : 'none'}: ${egp(p.retention.held)} held, ${egp(p.retention.released)} released, ${egp(p.retention.open)} open. Advances: ${egp(p.advances.paid)} paid, ${egp(p.advances.setOff)} set off, ${egp(p.advances.open)} open. Invoices: ${egp(p.invoices.approved)} to pay, ${egp(p.invoices.paid)} paid.`}
            />
            {can('finance.payables') ? (
              <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
                <Field label="Ask for">
                  {(f) => (
                    <Select {...f} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                      <option value="advance">An advance</option>
                      <option value="retention_release">The retention’s release (after its end)</option>
                    </Select>
                  )}
                </Field>
                <Field label="EGP" error={fieldError(ask.error, 'amount')}>
                  {(f) => <Input {...f} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
                </Field>
                <Button loading={ask.isPending} disabled={!amount.trim()} onClick={() => ask.mutate()}>
                  Ask
                </Button>
              </div>
            ) : null}
            <ErrorAlert error={ask.error} />
          </Card>
          <Card flush>
            <DataTable<Disbursement>
              rows={p.disbursements}
              rowKey={(d) => d.id}
              empty="No advance or release"
              columns={[
                { key: 'n', header: 'Request', cell: (d) => `${d.number} · ${humanize(d.kind)}` },
                { key: 'a', header: 'Amount', cell: (d) => egp(d.amount) },
                { key: 's', header: 'Status', cell: (d) => humanize(d.status) },
                { key: 'x', header: '', cell: (d) => <DisbursementActions d={d} /> },
              ]}
            />
          </Card>
          <Card flush>
            <DataTable
              rows={p.guarantees}
              rowKey={(g) => g.id}
              empty="No guarantee"
              columns={[
                { key: 'k', header: 'Guarantee', cell: (g) => `${humanize(g.kind)} · ${g.issuer} ${g.reference}` },
                { key: 'a', header: 'Amount', cell: (g) => egp(g.amount) },
                { key: 'e', header: 'Expires', cell: (g) => formatDate(g.expiresOn) },
                { key: 's', header: 'Status', cell: (g) => humanize(g.status) },
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
  const { ready, can } = usePermissions();
  const allowed = can('finance.payables') || can('finance.payables_approve');
  const [contractId, setContractId] = useState('');
  const pending = useQuery({ queryKey: keys.disbursements, queryFn: fetchers.disbursements, enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Advances, retentions and guarantees" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Advances, retentions and guarantees"
        description="An advance is set off against the contract’s later invoices; a retention held of each payout is released at its end. Nobody approves what they asked for."
      />
      <Card flush>
        <CardHeader title="Waiting for a decision or a payout" />
        <QueryState query={pending}>
          <DataTable<Disbursement>
            rows={pending.data ?? []}
            rowKey={(d) => d.id}
            empty="Nothing waiting"
            columns={[
              { key: 'n', header: 'Request', cell: (d) => `${d.number} · ${humanize(d.kind)}` },
              { key: 'a', header: 'Amount', cell: (d) => egp(d.amount) },
              { key: 's', header: 'Status', cell: (d) => humanize(d.status) },
              { key: 'c', header: '', cell: (d) => <Button size="sm" onClick={() => setContractId(d.contractId)}>Its contract</Button> },
              { key: 'x', header: '', cell: (d) => <DisbursementActions d={d} /> },
            ]}
          />
        </QueryState>
      </Card>
      <Field label="Contract id">
        {(f) => <Input {...f} value={contractId} onChange={(e) => setContractId(e.target.value.trim())} />}
      </Field>
      {/^[0-9a-f-]{36}$/.test(contractId) ? <ContractMoney contractId={contractId} /> : null}
    </>
  );
}
