'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Account = Schema<'CashAccountView'>;
type Movement = Schema<'CashMovementView'>;
const KEY = ['finance', 'cash-accounts'] as const;
const MOVES = ['finance', 'cash-movements'] as const;
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');
const today = () => new Date().toLocaleDateString('en-CA');
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;

function NewAccount({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<'bank' | 'cash'>('bank');
  const [name, setName] = useState('');
  const [bankName, setBankName] = useState('');
  const [last4, setLast4] = useState('');
  const [opening, setOpening] = useState('');
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/cash-accounts', {
          body: {
            kind,
            name: name.trim(),
            openedOn: today(),
            ...(kind === 'bank' && bankName.trim() ? { bankName: bankName.trim() } : {}),
            ...(kind === 'bank' && last4 ? { numberLast4: last4 } : {}),
            ...(opening.trim() ? { openingBalance: opening.trim() } : {}),
          },
        }),
      ),
    { invalidate: [KEY], onDone: () => {
        toast.show('Account opened.');
        onClose();
      } },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Open an account"
      description="A register, not a ledger: its balance is the sum of what moved through it."
      onSubmit={() => name.trim() && create.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
            Open
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'bank' | 'cash')}>
              <option value="bank">Bank account</option>
              <option value="cash">Cash box</option>
            </Select>
          )}
        </Field>
        <Field label="Name" error={fieldError(create.error, 'name')}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        {kind === 'bank' ? (
          <>
            <Field label="Bank" error={fieldError(create.error, 'bankName')}>
              {(p) => <Input {...p} value={bankName} onChange={(e) => setBankName(e.target.value)} />}
            </Field>
            <Field label="Last four digits" hint="Never the whole number." error={fieldError(create.error, 'numberLast4')}>
              {(p) => <Input {...p} inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <Field label="Opening balance, EGP" hint="Optional." error={fieldError(create.error, 'openingBalance')}>
          {(p) => <Input {...p} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

function Transfer({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const move = useAction(
    () => unwrap(api.POST('/api/v1/staff/finance/cash-transfers', { body: { fromAccountId: from, toAccountId: to, amount: amount.trim(), onDay: today() } })),
    { invalidate: [KEY, MOVES], onDone: () => {
        toast.show('Moved.');
        onClose();
      } },
  );
  const ok = from && to && from !== to && MONEY.test(amount.trim());
  const pick = (value: string, set: (v: string) => void) => (
    <Field label={set === setFrom ? 'From' : 'To'}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">Choose…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.balance} EGP
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Move money between accounts"
      description="A cash box deposited at the bank, or the bank's cash drawn into a box. A cash box never goes below zero."
      onSubmit={() => ok && move.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={move.isPending} disabled={!ok}>
            Move
          </Button>
        </>
      }
    >
      <div className="form">
        {pick(from, setFrom)}
        {pick(to, setTo)}
        <Field label="Amount, EGP" error={fieldError(move.error, 'amount')}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <ErrorAlert error={move.error} />
      </div>
    </Dialog>
  );
}

function Adjust({ account, onClose }: { account: Account; onClose: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const adjust = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/cash-accounts/{id}/adjustments', {
          params: { path: { id: account.id } },
          body: { amount: amount.trim(), reasonCode: code, onDay: today() },
        }),
      ),
    { invalidate: [KEY, MOVES], onDone: () => {
        toast.show('Adjusted.');
        onClose();
      } },
  );
  const ok = /^-?\d{1,8}(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) !== 0 && code;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Adjust ${account.name}`}
      description="Positive in, negative out, with why. Kept for good: a mistake is another adjustment."
      onSubmit={() => ok && adjust.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={adjust.isPending} disabled={!ok}>
            Adjust
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Amount, EGP" error={fieldError(adjust.error, 'amount')}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Why" error={fieldError(adjust.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Choose…</option>
              {REASON_CODES.cashAdjust.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={adjust.error} />
      </div>
    </Dialog>
  );
}

function Movements({ account }: { account: Account }) {
  const moves = useQuery({
    queryKey: [...MOVES, account.id],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cash-movements', { params: { query: { accountId: account.id, limit: 100 } } })),
  });
  return (
    <Card flush>
      <CardHeader title={`${account.name}: movements`} />
      <QueryState query={moves}>
        <DataTable<Movement>
          rows={moves.data?.data}
          rowKey={(m) => m.id}
          empty="Nothing moved yet"
          columns={[
            { key: 'd', header: 'Day', cell: (m) => m.onDay },
            { key: 'k', header: 'What', cell: (m) => label(m.kind) + (m.reasonCode ? ` · ${label(m.reasonCode)}` : '') },
            { key: 'a', header: 'Amount', cell: (m) => <span className="t-mono">{m.amount}</span> },
            { key: 'b', header: 'By', cell: (m) => m.recordedBy.fullName ?? '—' },
          ]}
        />
      </QueryState>
    </Card>
  );
}

/**
 * Bank and cash accounts (ADR 0085): registers whose balances are the sum
 * of their movements — hand-ins, cheques cleared, bank transfers a
 * statement showed, transfers and adjustments. Not a ledger.
 */
export default function TreasuryPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.treasury');
  const accounts = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cash-accounts')),
    enabled: allowed,
  });
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState(false);
  const [adjusting, setAdjusting] = useState<Account | null>(null);
  const [shown, setShown] = useState<Account | null>(null);
  const retire = useAction(
    (a: Account) => unwrap(api.POST('/api/v1/staff/finance/cash-accounts/{id}/retire', { params: { path: { id: a.id } } })),
    { invalidate: [KEY], onDone: () => toast.show('Retired.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Bank and cash" />
        <ForbiddenState />
      </>
    );
  const rows = accounts.data?.data ?? [];
  return (
    <>
      <PageHeader
        title="Bank and cash"
        description="The compound’s bank accounts and cash boxes."
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Button onClick={() => setMoving(true)} disabled={rows.length < 2}>
              Move money
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              Open an account
            </Button>
          </span>
        }
      />
      <div className="stack">
        <ErrorAlert error={retire.error} />
        <Card flush>
          <QueryState query={accounts}>
            <DataTable<Account>
              rows={rows}
              rowKey={(a) => a.id}
              empty="No account yet"
              columns={[
                { key: 'n', header: 'Account', cell: (a) => a.name },
                { key: 'k', header: 'Kind', cell: (a) => (a.kind === 'bank' ? `Bank${a.bankName ? ` · ${a.bankName}` : ''}${a.numberLast4 ? ` ••${a.numberLast4}` : ''}` : 'Cash box') },
                { key: 'b', header: 'Balance', cell: (a) => <span className="t-mono">{a.balance} EGP</span> },
                {
                  key: 'w',
                  header: 'Waiting',
                  cell: (a) =>
                    a.unmatchedLines || a.pendingCheques ? (
                      <Badge tone="beige">{[a.unmatchedLines ? `${a.unmatchedLines} lines` : '', a.pendingCheques ? `${a.pendingCheques} cheques` : ''].filter(Boolean).join(' · ')}</Badge>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (a) => (
                    <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <Button size="sm" onClick={() => setShown(a)}>
                        Movements
                      </Button>
                      <Button size="sm" onClick={() => setAdjusting(a)}>
                        Adjust
                      </Button>
                      <Button size="sm" variant="danger" disabled={a.balance !== '0.00' || a.pendingCheques > 0} onClick={() => retire.mutate(a)}>
                        Retire
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </QueryState>
        </Card>
        {shown ? <Movements account={shown} /> : null}
      </div>
      {creating ? <NewAccount onClose={() => setCreating(false)} /> : null}
      {moving ? <Transfer accounts={rows} onClose={() => setMoving(false)} /> : null}
      {adjusting ? <Adjust account={adjusting} onClose={() => setAdjusting(null)} /> : null}
    </>
  );
}
