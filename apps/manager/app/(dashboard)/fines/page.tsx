'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useFormat, useT, type Translate } from '@jiwar/i18n';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { validReceipt } from '@/components/facilities/logic';
import { FineDialog, type FineBody } from '@/components/vehicles/fine-dialog';
import { fineActions } from '@/components/vehicles/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FineFilters, type FinePayment, type FineStatus, type StaffFine } from '@/lib/queries';
import ar from '@/messages/ar/fines';
import en from '@/messages/en/fines';

const today = () => new Date().toLocaleDateString('en-CA');
const VIEWS = ['unpaid', 'under_appeal', 'paid', 'cancelled', 'all'] as const;
type View = (typeof VIEWS)[number];
const who = (t: Translate<typeof en>, a: { fullName?: string | null; erased?: true } | null) =>
  a ? (a.erased ? t('erased') : (a.fullName ?? '—')) : '—';

function RecordPayment({ fine, onClose }: { fine: StaffFine; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const [receiptNumber, setReceipt] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/vehicle-fines/{id}/payments', {
          params: { path: { id: fine.id } },
          body: { amount: fine.amount, currency: 'EGP', receiptNumber: receiptNumber.trim(), paidOn },
        }),
      ),
    {
      invalidate: [keys.finesAll],
      onDone: () => {
        toast.show(t('paid'));
        onClose();
      },
    },
  );
  const ready = validReceipt(receiptNumber) && paidOn !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('payTitle', { reference: fine.reference })}
      description={t('payDescription', { amount: f.money(fine.amount) })}
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
        <Field
          label={t('receiptNumber')}
          hint={t('receiptHint')}
          error={fieldError(save.error, 'receiptNumber') ?? (receiptNumber && !validReceipt(receiptNumber) ? t('receiptInvalid') : undefined)}
        >
          {(p) => <Input {...p} maxLength={40} value={receiptNumber} onChange={(e) => setReceipt(e.target.value)} />}
        </Field>
        <Field label={t('paidOn')} hint={t('paidOnHint')} error={fieldError(save.error, 'paidOn')}>
          {(p) => <Input {...p} type="date" min={fine.occurredOn} max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function FineDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { can } = usePermissions();
  const fine = useQuery({ queryKey: keys.fine(id), queryFn: () => fetchers.fine(id) });
  const [step, setStep] = useState<'pay' | 'cancel' | 'accept' | null>(null);
  const [reversing, setReversing] = useState<FinePayment | null>(null);
  const decide = useAction(
    (input: { decision: 'upheld' | 'cancelled'; reasonCode?: string }) =>
      unwrap(api.POST('/api/v1/staff/vehicle-fines/{id}/decide-appeal', { params: { path: { id } }, body: input })),
    {
      invalidate: [keys.finesAll],
      onDone: (f) => {
        toast.show(f.status === 'cancelled' ? t('appealAccepted') : t('appealUpheld'));
        setStep(null);
      },
    },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/vehicle-fines/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.finesAll],
      onDone: () => {
        toast.show(t('cancelled'));
        setStep(null);
      },
    },
  );
  const reverse = useAction(
    (input: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/vehicle-fine-payments/{id}/reverse', { params: { path: { id: input.id } }, body: { reasonCode: input.reasonCode } })),
    {
      invalidate: [keys.finesAll],
      onDone: () => {
        toast.show(t('reversedToast'));
        setReversing(null);
      },
    },
  );
  const f = fine.data;
  const actions = f ? fineActions(f.status, { issue: can('fines.issue'), billing: can('fines.billing') }) : [];
  const reversed = new Set((f?.payments ?? []).filter((p) => p.kind === 'reversal').map((p) => p.reversesId));
  return (
    <>
      <Dialog
        open={step === null || step === 'cancel' || step === 'accept'}
        wide
        onClose={onClose}
        title={f ? t('detailTitle', { reference: f.reference, unit: f.unitCode }) : t('fine')}
        description={f ? `${label(f.reason)} · ${fmt.money(f.amount)} · ${fmt.day(f.occurredOn)}` : undefined}
        footer={
          <>
            {actions.includes('decide') ? (
              <>
                <Button loading={decide.isPending} onClick={() => decide.mutate({ decision: 'upheld' })}>
                  {t('uphold')}
                </Button>
                <Button variant="primary" onClick={() => setStep('accept')}>
                  {t('acceptAppeal')}
                </Button>
              </>
            ) : null}
            {actions.includes('pay') ? (
              <Button variant="primary" onClick={() => setStep('pay')}>
                {t('recordPayment')}
              </Button>
            ) : null}
            {actions.includes('cancel') ? (
              <Button variant="danger" onClick={() => setStep('cancel')}>
                {t('cancelFine')}
              </Button>
            ) : null}
            <Button onClick={onClose}>{c('close')}</Button>
          </>
        }
      >
        <QueryState query={fine} rows={4}>
          {f ? (
            <div className="stack">
              <dl className="dl">
                <dt>{t('status')}</dt>
                <dd>
                  <StatusBadge status={f.status} />
                  {f.cancelReason ? <span className="t-secondary"> · {label(f.cancelReason)}</span> : null}
                </dd>
                <dt>{t('plate')}</dt>
                <dd>
                  <bdi>{f.plate}</bdi>
                </dd>
                <dt>{t('issuedAt')}</dt>
                <dd>{t('issuedBy', { when: fmt.dateTime(f.createdAt), who: who(t, f.issuedBy) })}</dd>
                {f.note ? (
                  <>
                    <dt>{t('noteForUnit')}</dt>
                    <dd>{f.note}</dd>
                  </>
                ) : null}
              </dl>
              {f.photoUrl ? (
                <a className="btn btn--secondary btn--sm" href={f.photoUrl} target="_blank" rel="noreferrer">
                  {t('openPhoto')}
                </a>
              ) : null}
              {f.appeal ? (
                <Card>
                  <div className="stack stack--sm" style={{ padding: 16 }}>
                    <strong>{t('appeal')}</strong>
                    <span className="t-secondary">{t('issuedBy', { when: fmt.dateTime(f.appeal.appealedAt), who: who(t, f.appealedBy) })}</span>
                    <span>{f.appeal.reason ?? <span className="t-secondary">{t('appealErased')}</span>}</span>
                    {f.appeal.photoUrl ? (
                      <a href={f.appeal.photoUrl} target="_blank" rel="noreferrer">
                        {t('appealPhoto')}
                      </a>
                    ) : null}
                    {f.appeal.decision ? (
                      <Badge tone={f.appeal.decision === 'upheld' ? 'beige' : 'green'}>
                        {f.appeal.decision === 'upheld' ? t('decision.upheld') : t('decision.cancelled')} · {who(t, f.decidedBy)}
                      </Badge>
                    ) : null}
                  </div>
                </Card>
              ) : null}
              <Card flush>
                <DataTable<FinePayment>
                  rows={f.payments}
                  rowKey={(p) => p.id}
                  empty={t('noPayment')}
                  columns={[
                    {
                      key: 'kind',
                      header: '',
                      cell: (p) =>
                        p.kind === 'reversal' ? (
                          <Badge tone="error">{t('payment.reversal')}</Badge>
                        ) : reversed.has(p.id) ? (
                          <Badge tone="beige">{t('payment.reversed')}</Badge>
                        ) : (
                          <Badge tone="green">{t('payment.payment')}</Badge>
                        ),
                    },
                    { key: 'paid', header: t('col.paidOn'), cell: (p) => (p.paidOn ? fmt.day(p.paidOn) : fmt.date(p.createdAt)) },
                    { key: 'amount', header: t('col.amount'), cell: (p) => (p.amount ? fmt.money(p.amount) : label(p.reasonCode)) },
                    { key: 'receipt', header: t('col.receipt'), cell: (p) => <span className="t-mono">{p.receiptNumber ?? '—'}</span> },
                    { key: 'by', header: t('col.by'), cell: (p) => who(t, p.recordedBy) },
                    {
                      key: 'actions',
                      header: '',
                      className: 'table__actions',
                      cell: (p) =>
                        p.kind === 'payment' && !reversed.has(p.id) && can('fines.billing') ? (
                          <Button size="sm" onClick={() => setReversing(p)}>
                            {t('reverse')}
                          </Button>
                        ) : null,
                    },
                  ]}
                />
              </Card>
              <ErrorAlert error={decide.error} />
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {f && step === 'pay' ? <RecordPayment fine={f} onClose={() => setStep(null)} /> : null}
      <ReasonCodeDialog
        open={step === 'accept'}
        onClose={() => setStep(null)}
        title={t('acceptTitle', { reference: f?.reference })}
        description={t('acceptDescription')}
        codes={REASON_CODES.vehicleFineCancel}
        confirmLabel={t('acceptConfirm')}
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ decision: 'cancelled', reasonCode })}
      />
      <ReasonCodeDialog
        open={step === 'cancel'}
        onClose={() => setStep(null)}
        title={t('cancelTitle', { reference: f?.reference })}
        description={t('cancelDescription')}
        codes={REASON_CODES.vehicleFineCancel.filter((code) => code !== 'appeal_accepted')}
        confirmLabel={t('cancelFine')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
      <ReasonCodeDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        title={t('reverseTitle', { receipt: reversing?.receiptNumber })}
        description={t('reverseDescription')}
        codes={REASON_CODES.vehicleFinePaymentReverse}
        confirmLabel={t('reverse')}
        danger
        pending={reverse.isPending}
        error={<ErrorAlert error={reverse.error} />}
        onConfirm={(reasonCode) => reversing && reverse.mutate({ id: reversing.id, reasonCode })}
      />
    </>
  );
}

/**
 * Vehicle fines (ADR 0045): issued to a unit, appealed once by its people,
 * decided by the staff, and paid at the office (`fines.billing`, the
 * accountant). The unit never sees where a fine came from.
 */
export default function FinesPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('fines.issue') || can('fines.billing');
  const [view, setView] = useState<View>(can('fines.issue') ? 'under_appeal' : 'unpaid');
  const [unitCode, setUnitCode] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('fine');
    if (linked) setOpen(linked);
  }, []);
  const filters: FineFilters = { status: view === 'all' ? '' : (view as FineStatus), unitCode: unitCode.trim() };
  const list = useCursorList(keys.fines(filters), (c) => fetchers.fines(filters, c), { enabled: allowed });
  const issue = useAction(
    (body: FineBody) => unwrap(api.POST('/api/v1/staff/vehicle-fines', { body })),
    {
      invalidate: [keys.finesAll],
      onDone: (f) => {
        toast.show(t('issued', { reference: f.reference }));
        setIssuing(false);
      },
    },
  );
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
          can('fines.issue') ? (
            <Button variant="primary" onClick={() => setIssuing(true)}>
              {t('issue')}
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
        <Field label={t('unitCode')}>
          {(p) => <Input {...p} placeholder={t('unitCodePlaceholder')} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffFine>
            rows={list.rows}
            rowKey={(f) => f.id}
            empty={view === 'under_appeal' ? t('emptyAppeals') : t('emptyMatch')}
            columns={[
              {
                key: 'ref',
                header: t('col.fine'),
                cell: (f) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(f.id)}>
                    {f.reference}
                  </Button>
                ),
              },
              { key: 'unit', header: t('col.unit'), cell: (f) => <span className="t-mono">{f.unitCode}</span> },
              { key: 'plate', header: t('col.plate'), cell: (f) => <bdi>{f.plate}</bdi> },
              { key: 'reason', header: t('col.reason'), cell: (f) => label(f.reason) },
              { key: 'amount', header: t('col.amount'), cell: (f) => fmt.money(f.amount) },
              { key: 'status', header: t('col.status'), cell: (f) => <StatusBadge status={f.status} /> },
              // ADR 0070: a fine issued now is owed through the unit's invoice, payable online.
              {
                key: 'payable',
                header: t('col.payable'),
                cell: (f) => (f.payable === 'online' ? <Badge tone="green">{t('payable.online')}</Badge> : <Badge tone="beige">{t('payable.office')}</Badge>),
              },
              { key: 'when', header: t('col.issued'), cell: (f) => <span title={fmt.dateTime(f.createdAt)}>{fmt.relative(f.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <FineDetail id={open} onClose={() => setOpen(null)} /> : null}
      {issuing ? (
        <FineDialog
          title={t('issue')}
          description={t('issueDescription')}
          confirmLabel={t('issueConfirm')}
          pending={issue.isPending}
          error={issue.error}
          onSubmit={(body) => issue.mutate(body)}
          onClose={() => setIssuing(false)}
        />
      ) : null}
    </>
  );
}
