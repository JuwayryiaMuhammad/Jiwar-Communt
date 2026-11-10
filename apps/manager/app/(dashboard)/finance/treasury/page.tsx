'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/fin-treasury';
import en from '@/messages/en/fin-treasury';

type Account = Schema<'CashAccountView'>;
type Movement = Schema<'CashMovementView'>;
const KEY = ['finance', 'cash-accounts'] as const;
const MOVES = ['finance', 'cash-movements'] as const;
const today = () => new Date().toLocaleDateString('en-CA');
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;

function NewAccount({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('new.done'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('new.title')}
      description={t('new.description')}
      onSubmit={() => name.trim() && create.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
            {t('new.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('new.kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'bank' | 'cash')}>
              <option value="bank">{t('new.bankAccount')}</option>
              <option value="cash">{t('new.cashBox')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('new.name')} error={fieldError(create.error, 'name')}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        {kind === 'bank' ? (
          <>
            <Field label={t('new.bank')} error={fieldError(create.error, 'bankName')}>
              {(p) => <Input {...p} value={bankName} onChange={(e) => setBankName(e.target.value)} />}
            </Field>
            <Field label={t('new.last4')} hint={t('new.last4Hint')} error={fieldError(create.error, 'numberLast4')}>
              {(p) => <Input {...p} className="ltr" inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <Field label={t('new.opening')} hint={t('new.openingHint')} error={fieldError(create.error, 'openingBalance')}>
          {(p) => <Input {...p} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

function Transfer({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const move = useAction(
    () => unwrap(api.POST('/api/v1/staff/finance/cash-transfers', { body: { fromAccountId: from, toAccountId: to, amount: amount.trim(), onDay: today() } })),
    {
      invalidate: [KEY, MOVES],
      onDone: () => {
        toast.show(t('move.done'));
        onClose();
      },
    },
  );
  const ok = from && to && from !== to && MONEY.test(amount.trim());
  const pick = (title: string, value: string, set: (v: string) => void) => (
    <Field label={title}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{t('move.choose')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {f.money(a.balance)}
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
      title={t('move.title')}
      description={t('move.description')}
      onSubmit={() => ok && move.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={move.isPending} disabled={!ok}>
            {t('move.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        {pick(t('move.from'), from, setFrom)}
        {pick(t('move.to'), to, setTo)}
        <Field label={t('move.amount')} error={fieldError(move.error, 'amount')}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <ErrorAlert error={move.error} />
      </div>
    </Dialog>
  );
}

function Adjust({ account, onClose }: { account: Account; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
    {
      invalidate: [KEY, MOVES],
      onDone: () => {
        toast.show(t('adjust.done'));
        onClose();
      },
    },
  );
  const ok = /^-?\d{1,8}(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) !== 0 && code;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('adjust.title', { name: account.name })}
      description={t('adjust.description')}
      onSubmit={() => ok && adjust.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={adjust.isPending} disabled={!ok}>
            {t('adjust.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('move.amount')} error={fieldError(adjust.error, 'amount')}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('adjust.why')} error={fieldError(adjust.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">{t('move.choose')}</option>
              {REASON_CODES.cashAdjust.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const moves = useQuery({
    queryKey: [...MOVES, account.id],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cash-movements', { params: { query: { accountId: account.id, limit: 100 } } })),
  });
  return (
    <Card flush>
      <CardHeader title={t('movementsOf', { name: account.name })} />
      <QueryState query={moves}>
        <DataTable<Movement>
          rows={moves.data?.data}
          rowKey={(m) => m.id}
          empty={t('noMovement')}
          columns={[
            { key: 'd', header: t('day'), cell: (m) => f.day(m.onDay) },
            { key: 'k', header: t('what'), cell: (m) => label(m.kind) + (m.reasonCode ? ` · ${label(m.reasonCode)}` : '') },
            { key: 'a', header: c('amount'), cell: (m) => <span className="t-mono">{f.number(m.amount, { minimumFractionDigits: 2 })}</span> },
            { key: 'b', header: t('by'), cell: (m) => m.recordedBy.fullName ?? '—' },
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
  const t = useT(en, ar);
  const f = useFormat();
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
    { invalidate: [KEY], onDone: () => toast.show(t('retired')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const rows = accounts.data?.data ?? [];
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Button onClick={() => setMoving(true)} disabled={rows.length < 2}>
              {t('moveMoney')}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('openAccount')}
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
              empty={t('empty')}
              columns={[
                { key: 'n', header: t('account'), cell: (a) => a.name },
                {
                  key: 'k',
                  header: t('kind'),
                  cell: (a) =>
                    a.kind === 'bank' ? (
                      <>
                        {a.bankName ? t('bankWith', { name: a.bankName }) : t('bank')}
                        {a.numberLast4 ? <span className="ltr"> ••{a.numberLast4}</span> : null}
                      </>
                    ) : (
                      t('cashBox')
                    ),
                },
                { key: 'b', header: t('balance'), cell: (a) => <span className="t-mono">{f.money(a.balance)}</span> },
                {
                  key: 'w',
                  header: t('waiting'),
                  cell: (a) =>
                    a.unmatchedLines || a.pendingCheques ? (
                      <Badge tone="beige">
                        {[a.unmatchedLines ? t('lines', { n: a.unmatchedLines }) : '', a.pendingCheques ? t('cheques', { n: a.pendingCheques }) : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </Badge>
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
                        {t('movements')}
                      </Button>
                      <Button size="sm" onClick={() => setAdjusting(a)}>
                        {t('adjust')}
                      </Button>
                      <Button size="sm" variant="danger" disabled={a.balance !== '0.00' || a.pendingCheques > 0} onClick={() => retire.mutate(a)}>
                        {t('retire')}
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
