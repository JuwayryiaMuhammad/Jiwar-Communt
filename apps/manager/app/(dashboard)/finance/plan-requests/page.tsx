'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { validMoney } from '@/components/finance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/fin-plan-requests';
import en from '@/messages/en/fin-plan-requests';

type PlanRequest = Schema<'PlanRequestView'>;
type Status = PlanRequest['status'];
const KEY = ['finance', 'plan-requests'] as const;
const SETTINGS = ['finance', 'plan-settings'] as const;
const STATUSES = ['pending', 'accepted', 'declined', 'withdrawn', 'lapsed'] as const satisfies readonly Status[];

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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
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
        toast.show(t('accepted', { invoice: request.invoiceNumber, n: rows.length }));
        onClose();
      },
    },
  );
  const ready = rows.length >= 2 && rows.every((r) => validMoney(r.amount) && /^\d{4}-\d{2}-\d{2}$/.test(r.dueOn));
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('acceptTitle', { invoice: request.invoiceNumber })}
      description={t('acceptDescription', { months: request.months })}
      onSubmit={() => ready && accept.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={accept.isPending} disabled={!ready}>
            {t('accept')}
          </Button>
        </>
      }
    >
      <QueryState query={invoice}>
        <div className="form">
          <p className="t-secondary">{t('owedNow', { amount: fmt.money(invoice.data?.outstanding) })}</p>
          {rows.map((r, i) => (
            <div className="row" key={i} style={{ gap: 8 }}>
              <Field label={t('rowDue', { n: i + 1 })} error={fieldError(accept.error, `instalments.${i}.dueOn`)}>
                {(p) => <Input {...p} type="date" value={r.dueOn} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)))} />}
              </Field>
              <Field label={t('egp')} error={fieldError(accept.error, `instalments.${i}.amount`)}>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [code, setCode] = useState('');
  const decline = useAction(
    () => unwrap(api.POST('/api/v1/staff/plan-requests/{id}/decline', { params: { path: { id: request.id } }, body: { reasonCode: code } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('declined'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('declineTitle', { invoice: request.invoiceNumber })}
      onSubmit={() => code && decline.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="danger" loading={decline.isPending} disabled={!code}>
            {t('decline')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('why')} error={fieldError(decline.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">{c('select')}</option>
              {REASON_CODES.planRequestDecline.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
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
  const t = useT(en, ar);
  const c = useCommonT();
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
    { invalidate: [SETTINGS], onDone: () => toast.show(t('saved')) },
  );
  const n = Number(months);
  const valid = Number.isInteger(n) && n >= 2 && n <= 24 && (floor.trim() === '' || validMoney(floor));
  return (
    <Card>
      <CardHeader title={t('terms')} />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field label={t('maxMonths')} hint={t('maxMonthsHint')} error={fieldError(save.error, 'planMaxMonths')}>
              {(p) => <Input {...p} type="number" min={2} max={24} value={months} onChange={(e) => setMonths(e.target.value)} />}
            </Field>
            <Field label={t('offerFrom')} hint={t('offerFromHint')} error={fieldError(save.error, 'planOfferMinAmount')}>
              {(p) => <Input {...p} inputMode="decimal" value={floor} onChange={(e) => setFloor(e.target.value)} />}
            </Field>
            <Checkbox label={t('duesNotice')} checked={dues} onChange={(e) => setDues(e.target.checked)} />
            <div>
              <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
                {c('save')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="stack">
        <Segmented<Status> label={c('status')} value={status} onChange={setStatus} options={STATUSES.map((v) => ({ value: v, label: t(`status.${v}`) }))} />
        <Card flush>
          <QueryState query={list}>
            <DataTable<PlanRequest>
              rows={list.data?.data}
              rowKey={(r) => r.id}
              empty={t('empty')}
              columns={[
                { key: 'i', header: t('col.invoice'), cell: (r) => <span className="t-mono">{r.invoiceNumber}</span> },
                { key: 'm', header: t('col.months'), cell: (r) => fmt.number(r.months) },
                { key: 's', header: c('status'), cell: (r) => <Badge tone={r.status === 'pending' ? 'terracotta' : 'beige'}>{t(`status.${r.status}`)}</Badge> },
                { key: 'c', header: t('col.asked'), cell: (r) => fmt.dateTime(r.createdAt) },
                {
                  key: 'a',
                  header: '',
                  className: 'table__actions',
                  cell: (r) =>
                    r.status === 'pending' ? (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <Button size="sm" variant="primary" onClick={() => setAccepting(r)}>
                          {t('accept')}
                        </Button>
                        <Button size="sm" onClick={() => setDeclining(r)}>
                          {t('decline')}
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
