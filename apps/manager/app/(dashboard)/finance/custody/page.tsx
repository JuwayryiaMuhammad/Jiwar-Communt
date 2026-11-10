'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/fin-custody';
import en from '@/messages/en/fin-custody';

type Summary = Schema<'CustodySummaryView'>;
type Handin = Schema<'CustodyHandinView'>;
type Investigation = Schema<'CustodyInvestigationView'>;
const KEY = ['finance', 'custody'] as const;
const COUNT = /^\d{1,8}(\.\d{1,2})?$/;

/** The receiver counts the cash against what the custodian holds now. */
function HandIn({ custodian, onClose }: { custodian: Summary; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
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
        toast.show(differs ? t('handedInVariance') : t('handedIn'));
        onClose();
      },
    },
  );
  const ok = box && COUNT.test(counted.trim()) && (!differs || reason);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('handInTitle', { name: custodian.custodian.fullName ?? t('aStaffMember') })}
      description={t('handInDescription', { payments: t('payments', { n: custodian.openCount }), amount: f.money(custodian.expected) })}
      onSubmit={() => ok && record.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={record.isPending} disabled={!ok}>
            {t('recordHandIn')}
          </Button>
        </>
      }
    >
      <QueryState query={boxes}>
        <div className="form">
          <Field label={t('intoBox')} error={fieldError(record.error, 'cashAccountId')}>
            {(p) => (
              <Select {...p} value={box} onChange={(e) => setBox(e.target.value)}>
                <option value="">{t('choose')}</option>
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
          <Field label={t('countedEgp')} error={fieldError(record.error, 'counted')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" value={counted} onChange={(e) => setCounted(e.target.value)} />}
          </Field>
          {differs ? (
            <Field label={t('whyDiffers')} error={fieldError(record.error, 'varianceReason')}>
              {(p) => (
                <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">{t('choose')}</option>
                  {REASON_CODES.custodyVariance.map((k) => (
                    <option key={k} value={k}>
                      {label(k)}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
        toast.show(t('settled'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('settleTitle', { number: investigation?.handinNumber ?? handin?.number ?? '' })}
      onSubmit={() => code && settle.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={settle.isPending} disabled={!code}>
            {t('settle')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('outcome')} error={fieldError(settle.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">{t('choose')}</option>
              {REASON_CODES.custodyOutcome.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {code === 'recovered' ? (
          <Field label={t('recoveredEgp')} hint={t('recoveredHint')} error={fieldError(settle.error, 'recoveredAmount')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" value={recovered} onChange={(e) => setRecovered(e.target.value)} />}
          </Field>
        ) : null}
        <ErrorAlert error={settle.error} />
      </div>
    </Dialog>
  );
}

function Investigate({ handin, onClose }: { handin: Handin; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const staff = useQuery({ queryKey: ['accounts', 'staff'], queryFn: () => unwrap(api.GET('/api/v1/accounts', { params: { query: { limit: 100 } } })) });
  const [owner, setOwner] = useState('');
  const [dueOn, setDueOn] = useState('');
  const open = useAction(
    () => unwrap(api.POST('/api/v1/staff/finance/custody-handins/{id}/investigation', { params: { path: { id: handin.id } }, body: { ownerId: owner, dueOn } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('investigationOpened'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('investigateTitle', { number: handin.number })}
      description={t('investigateDescription')}
      onSubmit={() => owner && dueOn && open.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={open.isPending} disabled={!owner || !dueOn}>
            {t('open')}
          </Button>
        </>
      }
    >
      <QueryState query={staff}>
        <div className="form">
          <Field label={t('col.owner')} error={fieldError(open.error, 'ownerId')}>
            {(p) => (
              <Select {...p} value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">{t('choose')}</option>
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
          <Field label={t('col.due')} hint={t('dueHint')} error={fieldError(open.error, 'dueOn')}>
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
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
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
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="stack">
        <Card flush>
          <CardHeader title={t('notHandedIn')} />
          <QueryState query={summary}>
            <DataTable<Summary>
              rows={summary.data?.data}
              rowKey={(r) => r.custodian.id}
              empty={t('everyoneHandedIn')}
              columns={[
                { key: 'w', header: t('col.who'), cell: (r) => r.custodian.fullName ?? '—' },
                { key: 'n', header: t('col.payments'), cell: (r) => f.number(r.openCount) },
                { key: 'e', header: t('col.expected'), cell: (r) => <span className="t-mono ltr">{f.money(r.expected)}</span> },
                {
                  key: 'a',
                  header: t('col.oldest'),
                  cell: (r) => (r.ageHours === null ? '—' : <Badge tone={r.ageHours >= 24 ? 'error' : 'beige'}>{t('hours', { n: f.number(r.ageHours) })}</Badge>),
                },
                { key: 'v', header: t('col.variancesOpen'), cell: (r) => (r.unresolvedVariances ? f.number(r.unresolvedVariances) : '—') },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (r) =>
                    r.openCount ? (
                      <Button size="sm" variant="primary" onClick={() => setHanding(r)}>
                        {t('handIn')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
        <Card flush>
          <CardHeader title={t('variancesTitle')} />
          <QueryState query={variances}>
            <DataTable<Handin>
              rows={variances.data?.data}
              rowKey={(r) => r.id}
              empty={t('none')}
              columns={[
                { key: 'n', header: t('col.handin'), cell: (r) => <span className="t-mono ltr">{r.number}</span> },
                { key: 'c', header: t('col.custodian'), cell: (r) => r.custodian.fullName ?? '—' },
                { key: 'v', header: t('col.variance'), cell: (r) => <span className="t-mono ltr">{f.money(r.variance)}</span> },
                { key: 'r', header: t('col.why'), cell: (r) => (r.varianceReason ? label(r.varianceReason) : '—') },
                { key: 'd', header: t('col.counted'), cell: (r) => f.dateTime(r.createdAt) },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (r) =>
                    keeper && !r.investigationId ? (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <Button size="sm" onClick={() => setInvestigating(r)}>
                          {t('investigate')}
                        </Button>
                        <Button size="sm" variant="primary" onClick={() => setSettling({ handin: r })}>
                          {t('settle')}
                        </Button>
                      </span>
                    ) : r.investigationId ? (
                      <Badge tone="beige">{t('investigating')}</Badge>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
        <Card flush>
          <CardHeader title={t('investigationsTitle')} />
          <QueryState query={investigations}>
            <DataTable<Investigation>
              rows={investigations.data?.data}
              rowKey={(r) => r.id}
              empty={t('none')}
              columns={[
                { key: 'n', header: t('col.handin'), cell: (r) => <span className="t-mono ltr">{r.handinNumber}</span> },
                { key: 'o', header: t('col.owner'), cell: (r) => r.owner.fullName ?? '—' },
                { key: 'd', header: t('col.due'), cell: (r) => (r.overdue ? <Badge tone="error">{f.day(r.dueOn)}</Badge> : f.day(r.dueOn)) },
                {
                  key: 'x',
                  header: '',
                  className: 'table__actions',
                  cell: (r) => (
                    <Button size="sm" variant="primary" onClick={() => setSettling({ investigation: r })}>
                      {t('decide')}
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
