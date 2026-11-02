'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Cheque = Schema<'ChequeView'>;
type Filter = 'all' | Cheque['status'];
const KEY = ['finance', 'cheques'] as const;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'received', label: 'Held' },
  { value: 'deposited', label: 'Deposited' },
  { value: 'cleared', label: 'Cleared' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'returned', label: 'Given back' },
];
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');
const today = () => new Date().toLocaleDateString('en-CA');

function Receive({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [unitId, setUnitId] = useState('');
  const [number, setNumber] = useState('');
  const [bank, setBank] = useState('');
  const [amount, setAmount] = useState('');
  const [dueOn, setDueOn] = useState(today());
  const receive = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/cheques', {
          params: { path: { unitId } },
          body: { number: number.trim(), amount: amount.trim(), dueOn, receivedOn: today(), ...(bank.trim() ? { bankName: bank.trim() } : {}) },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(dueOn > today() ? 'Held until its day.' : 'Received: it paid the unit’s invoices.');
        onClose();
      },
    },
  );
  const ok = unitId && number.trim() && /^\d{1,7}(\.\d{1,2})?$/.test(amount.trim()) && dueOn;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Receive a cheque"
      description="Dated today or earlier, it pays at once. Post-dated, it is held and pays when deposited."
      onSubmit={() => ok && receive.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={receive.isPending} disabled={!ok}>
            Receive
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Unit">{(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}</Field>
        <Field label="Cheque number" error={fieldError(receive.error, 'number')}>
          {(p) => <Input {...p} value={number} onChange={(e) => setNumber(e.target.value)} />}
        </Field>
        <Field label="Bank" hint="Optional." error={fieldError(receive.error, 'bankName')}>
          {(p) => <Input {...p} value={bank} onChange={(e) => setBank(e.target.value)} />}
        </Field>
        <Field label="Amount, EGP" error={fieldError(receive.error, 'amount')}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="The cheque’s date" error={fieldError(receive.error, 'dueOn')}>
          {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={receive.error} />
      </div>
    </Dialog>
  );
}

function Step({ cheque, what, onClose }: { cheque: Cheque; what: 'deposit' | 'bounce' | 'return'; onClose: () => void }) {
  const toast = useToast();
  const banks = useQuery({ queryKey: ['finance', 'cash-accounts'], queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cash-accounts')), enabled: what === 'deposit' });
  const [value, setValue] = useState('');
  const path = { params: { path: { id: cheque.id } } };
  const act = useAction(
    () =>
      what === 'deposit'
        ? unwrap(api.POST('/api/v1/staff/finance/cheques/{id}/deposit', { ...path, body: { accountId: value } }))
        : what === 'bounce'
          ? unwrap(api.POST('/api/v1/staff/finance/cheques/{id}/bounce', { ...path, body: { reasonCode: value } }))
          : unwrap(api.POST('/api/v1/staff/finance/cheques/{id}/return', { ...path, body: { reasonCode: value } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(what === 'deposit' ? 'Deposited.' : what === 'bounce' ? 'Bounced: its payment was reversed.' : 'Given back.');
        onClose();
      },
    },
  );
  const codes = what === 'bounce' ? REASON_CODES.chequeBounce : REASON_CODES.chequeReturn;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${label(what)} cheque ${cheque.number}`}
      description={`${cheque.amount} EGP · unit ${cheque.unitCode}`}
      onSubmit={() => value && act.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={what === 'deposit' ? 'primary' : 'danger'} loading={act.isPending} disabled={!value}>
            {label(what)}
          </Button>
        </>
      }
    >
      <div className="form">
        {what === 'deposit' ? (
          <Field label="Into" error={fieldError(act.error, 'accountId')}>
            {(p) => (
              <Select {...p} value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">Choose a bank account…</option>
                {banks.data?.data
                  .filter((a) => a.kind === 'bank')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field label="Why" error={fieldError(act.error, 'reasonCode')}>
            {(p) => (
              <Select {...p} value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">Choose…</option>
                {codes.map((c) => (
                  <option key={c} value={c}>
                    {label(c)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <ErrorAlert error={act.error} />
      </div>
    </Dialog>
  );
}

/**
 * The cheque register (ADR 0085): every cheque from the day it is
 * received; post-dated ones held until their day; deposited, then cleared
 * or bounced — a bounce reverses the payment it made.
 */
export default function ChequesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.payments');
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const list = useQuery({
    queryKey: [...KEY, filter],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cheques', { params: { query: filter === 'all' ? { limit: 100 } : { status: filter, limit: 100 } } })),
    enabled: allowed,
  });
  const clear = useAction((c: Cheque) => unwrap(api.POST('/api/v1/staff/finance/cheques/{id}/clear', { params: { path: { id: c.id } } })), {
    invalidate: [KEY],
    onDone: () => toast.show('Cleared: its money is in the bank account.'),
  });
  const [receiving, setReceiving] = useState(false);
  const [stepping, setStepping] = useState<{ cheque: Cheque; what: 'deposit' | 'bounce' | 'return' } | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Cheques" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Cheques"
        description="Cheques the units paid with, post-dated ones included."
        actions={
          <Button variant="primary" onClick={() => setReceiving(true)}>
            Receive a cheque
          </Button>
        }
      />
      <div className="stack">
        <Segmented label="Status" value={filter} onChange={setFilter} options={FILTERS} />
        <ErrorAlert error={clear.error} />
        <Card flush>
          <QueryState query={list}>
            <DataTable<Cheque>
              rows={list.data?.data}
              rowKey={(c) => c.id}
              empty="None"
              columns={[
                { key: 'n', header: 'Cheque', cell: (c) => <span className="t-mono">{c.number}</span> },
                { key: 'u', header: 'Unit', cell: (c) => <span className="t-mono">{c.unitCode}</span> },
                { key: 'a', header: 'Amount', cell: (c) => `${c.amount} EGP` },
                { key: 'd', header: 'Dated', cell: (c) => (c.postDated ? <Badge tone="beige">{c.dueOn}</Badge> : c.dueOn) },
                {
                  key: 's',
                  header: 'Status',
                  cell: (c) => (
                    <Badge tone={c.status === 'cleared' ? 'green' : c.status === 'bounced' ? 'error' : 'beige'}>
                      {c.status === 'received' && !c.paymentId ? 'Held' : label(c.status)}
                    </Badge>
                  ),
                },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (c) => (
                    <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      {c.status === 'received' ? (
                        <>
                          <Button size="sm" variant="primary" disabled={c.dueOn > today()} onClick={() => setStepping({ cheque: c, what: 'deposit' })}>
                            Deposit
                          </Button>
                          <Button size="sm" onClick={() => setStepping({ cheque: c, what: 'return' })}>
                            Give back
                          </Button>
                        </>
                      ) : null}
                      {c.status === 'deposited' ? (
                        <>
                          <Button size="sm" variant="primary" loading={clear.isPending} onClick={() => clear.mutate(c)}>
                            Cleared
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setStepping({ cheque: c, what: 'bounce' })}>
                            Bounced
                          </Button>
                        </>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          </QueryState>
        </Card>
      </div>
      {receiving ? <Receive onClose={() => setReceiving(false)} /> : null}
      {stepping ? <Step {...stepping} onClose={() => setStepping(null)} /> : null}
    </>
  );
}
