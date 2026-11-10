'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/fin-cheques';
import en from '@/messages/en/fin-cheques';

type Cheque = Schema<'ChequeView'>;
type Filter = 'all' | Cheque['status'];
const KEY = ['finance', 'cheques'] as const;
const today = () => new Date().toLocaleDateString('en-CA');

function Receive({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(dueOn > today() ? t('heldToast') : t('receivedToast'));
        onClose();
      },
    },
  );
  const ok = unitId && number.trim() && /^\d{1,7}(\.\d{1,2})?$/.test(amount.trim()) && dueOn;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('receiveCheque')}
      description={t('receiveDescription')}
      onSubmit={() => ok && receive.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={receive.isPending} disabled={!ok}>
            {t('receive')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('unit')}>{(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}</Field>
        <Field label={t('number')} error={fieldError(receive.error, 'number')}>
          {(p) => <Input {...p} className="ltr" value={number} onChange={(e) => setNumber(e.target.value)} />}
        </Field>
        <Field label={t('bank')} hint={t('bankHint')} error={fieldError(receive.error, 'bankName')}>
          {(p) => <Input {...p} value={bank} onChange={(e) => setBank(e.target.value)} />}
        </Field>
        <Field label={t('amountEgp')} error={fieldError(receive.error, 'amount')}>
          {(p) => <Input {...p} inputMode="decimal" className="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('chequeDate')} error={fieldError(receive.error, 'dueOn')}>
          {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={receive.error} />
      </div>
    </Dialog>
  );
}

function Step({ cheque, what, onClose }: { cheque: Cheque; what: 'deposit' | 'bounce' | 'return'; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
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
        toast.show(t(`done.${what}`));
        onClose();
      },
    },
  );
  const codes = what === 'bounce' ? REASON_CODES.chequeBounce : REASON_CODES.chequeReturn;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t(`stepTitle.${what}`, { number: cheque.number })}
      description={t('stepDescription', { amount: f.money(cheque.amount), unit: cheque.unitCode })}
      onSubmit={() => value && act.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant={what === 'deposit' ? 'primary' : 'danger'} loading={act.isPending} disabled={!value}>
            {t(`step.${what}`)}
          </Button>
        </>
      }
    >
      <div className="form">
        {what === 'deposit' ? (
          <Field label={t('into')} error={fieldError(act.error, 'accountId')}>
            {(p) => (
              <Select {...p} value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">{t('chooseBank')}</option>
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
          <Field label={t('why')} error={fieldError(act.error, 'reasonCode')}>
            {(p) => (
              <Select {...p} value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">{t('choose')}</option>
                {codes.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('finance.payments');
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: c('all') },
    { value: 'received', label: t('filter.received') },
    { value: 'deposited', label: label('deposited') },
    { value: 'cleared', label: label('cleared') },
    { value: 'bounced', label: label('bounced') },
    { value: 'returned', label: t('filter.returned') },
  ];
  const list = useQuery({
    queryKey: [...KEY, filter],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cheques', { params: { query: filter === 'all' ? { limit: 100 } : { status: filter, limit: 100 } } })),
    enabled: allowed,
  });
  const clear = useAction((ch: Cheque) => unwrap(api.POST('/api/v1/staff/finance/cheques/{id}/clear', { params: { path: { id: ch.id } } })), {
    invalidate: [KEY],
    onDone: () => toast.show(t('clearedToast')),
  });
  const [receiving, setReceiving] = useState(false);
  const [stepping, setStepping] = useState<{ cheque: Cheque; what: 'deposit' | 'bounce' | 'return' } | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setReceiving(true)}>
            {t('receiveCheque')}
          </Button>
        }
      />
      <div className="stack">
        <Segmented label={c('status')} value={filter} onChange={setFilter} options={filters} />
        <ErrorAlert error={clear.error} />
        <Card flush>
          <QueryState query={list}>
            <DataTable<Cheque>
              rows={list.data?.data}
              rowKey={(ch) => ch.id}
              empty={t('none')}
              columns={[
                { key: 'n', header: t('col.cheque'), cell: (ch) => <span className="t-mono ltr">{ch.number}</span> },
                { key: 'u', header: c('unit'), cell: (ch) => <span className="t-mono ltr">{ch.unitCode}</span> },
                { key: 'a', header: c('amount'), cell: (ch) => f.money(ch.amount) },
                { key: 'd', header: t('col.dated'), cell: (ch) => (ch.postDated ? <Badge tone="beige">{f.day(ch.dueOn)}</Badge> : f.day(ch.dueOn)) },
                {
                  key: 's',
                  header: c('status'),
                  cell: (ch) => (
                    <Badge tone={ch.status === 'cleared' ? 'green' : ch.status === 'bounced' ? 'error' : 'beige'}>
                      {ch.status === 'received' && !ch.paymentId ? t('held') : label(ch.status)}
                    </Badge>
                  ),
                },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (ch) => (
                    <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      {ch.status === 'received' ? (
                        <>
                          <Button size="sm" variant="primary" disabled={ch.dueOn > today()} onClick={() => setStepping({ cheque: ch, what: 'deposit' })}>
                            {t('deposit')}
                          </Button>
                          <Button size="sm" onClick={() => setStepping({ cheque: ch, what: 'return' })}>
                            {t('giveBack')}
                          </Button>
                        </>
                      ) : null}
                      {ch.status === 'deposited' ? (
                        <>
                          <Button size="sm" variant="primary" loading={clear.isPending} onClick={() => clear.mutate(ch)}>
                            {t('cleared')}
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setStepping({ cheque: ch, what: 'bounce' })}>
                            {t('bounced')}
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
