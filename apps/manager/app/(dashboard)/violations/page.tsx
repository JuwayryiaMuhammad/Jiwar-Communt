'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
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
  Select,
  StatusBadge,
  Textarea,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { validReceipt } from '@/components/facilities/logic';
import { FileUpload } from '@/components/file-upload';
import { personNameIn, postNameIn } from '@/components/security/logic';
import { violationActions } from '@/components/security/ops-logic';
import { addDays, validFineAmount } from '@/components/vehicles/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffViolation, type ViolationFilters, type ViolationPayment } from '@/lib/queries';
import ar from '@/messages/ar/violations';
import en from '@/messages/en/violations';

type Body = Schema<'IssueViolationDto'>;
type Status = NonNullable<ViolationFilters['status']>;

const today = () => new Date().toLocaleDateString('en-CA');
function IssueViolation({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [kind, setKind] = useState('');
  const [unitCode, setUnitCode] = useState('');
  const [permitId, setPermitId] = useState('');
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState(today());
  const [note, setNote] = useState('');
  const [photoFileId, setPhoto] = useState<string | null>(null);
  const hours = kind === 'contractor_hours';
  const body: Body = {
    kind: kind as Body['kind'],
    ...(hours && permitId.trim() ? { permitId: permitId.trim() } : { unitCode: unitCode.trim() }),
    occurredOn,
    ...(amount.trim() ? { amount: amount.trim() } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
    ...(photoFileId ? { photoFileId } : {}),
  };
  const issue = useAction(() => unwrap(api.POST('/api/v1/staff/violations', { body })), {
    invalidate: [keys.violationsAll],
    onDone: (v) => {
      toast.show(t('issuedToast', { reference: v.reference }));
      onClose();
    },
  });
  const ready = kind !== '' && (hours ? permitId.trim() !== '' || unitCode.trim() !== '' : unitCode.trim() !== '') && occurredOn !== '' && (!amount.trim() || validFineAmount(amount));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('issueTitle')}
      description={t('issueDescription')}
      onSubmit={() => ready && issue.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={issue.isPending} disabled={!ready}>
            {t('issue')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('kind')} error={fieldError(issue.error, 'kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{c('select')}</option>
              {REASON_CODES.violationKind.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {hours ? (
          <Field label={t('worksPermit')} hint={t('worksPermitHint')} error={fieldError(issue.error, 'permitId')}>
            {(p) => <Input {...p} value={permitId} onChange={(e) => setPermitId(e.target.value)} />}
          </Field>
        ) : null}
        {!hours || !permitId.trim() ? (
          <Field label={t('unitCode')} error={fieldError(issue.error, 'unitCode')}>
            {(p) => <Input {...p} className="ltr" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
          </Field>
        ) : null}
        <Field
          label={t('amountEgp')}
          hint={t('amountHint')}
          error={fieldError(issue.error, 'amount') ?? (amount && !validFineAmount(amount) ? t('amountInvalid') : undefined)}
        >
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('occurredOn')} hint={t('occurredOnHint')} error={fieldError(issue.error, 'occurredOn')}>
          {(p) => <Input {...p} type="date" min={addDays(today(), -90)} max={today()} value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />}
        </Field>
        <Field label={t('noteForUnit')} hint={t('noteHint')} error={fieldError(issue.error, 'note')}>
          {(p) => <Textarea {...p} maxLength={500} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Field label={t('photo')}>
          {() =>
            photoFileId ? (
              <span className="row" style={{ gap: 8 }}>
                <span className="t-secondary">{t('photoAttached')}</span>
                <Button size="sm" onClick={() => setPhoto(null)}>
                  {c('remove')}
                </Button>
              </span>
            ) : (
              <FileUpload purpose="violation_photo" label={t('addPhoto')} onUploaded={setPhoto} />
            )
          }
        </Field>
        <ErrorAlert error={issue.error} />
      </div>
    </Dialog>
  );
}

function RecordPayment({ violation, onClose }: { violation: StaffViolation; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const [receiptNumber, setReceipt] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/violations/{id}/payments', {
          params: { path: { id: violation.id } },
          body: { amount: violation.amount ?? '', currency: 'EGP', receiptNumber: receiptNumber.trim(), paidOn },
        }),
      ),
    {
      invalidate: [keys.violationsAll],
      onDone: () => {
        toast.show(t('paymentRecorded'));
        onClose();
      },
    },
  );
  const ready = validReceipt(receiptNumber) && paidOn !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('recordTitle', { reference: violation.reference })}
      description={t('recordDescription', { amount: violation.amount ? f.money(violation.amount) : '' })}
      onSubmit={() => ready && save.mutate(undefined)}
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
          {(p) => <Input {...p} type="date" min={violation.date} max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function ViolationDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const { can } = usePermissions();
  const violation = useQuery({ queryKey: keys.violation(id), queryFn: () => fetchers.violation(id) });
  const [step, setStep] = useState<'pay' | 'cancel' | 'accept' | null>(null);
  const [reversing, setReversing] = useState<ViolationPayment | null>(null);
  const decide = useAction(
    (input: { decision: 'upheld' | 'cancelled'; reasonCode?: string }) =>
      unwrap(api.POST('/api/v1/staff/violations/{id}/decide-appeal', { params: { path: { id } }, body: input })),
    {
      invalidate: [keys.violationsAll],
      onDone: (v) => {
        toast.show(v.status === 'cancelled' ? t('appealAccepted') : t('appealUpheld'));
        setStep(null);
      },
    },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/violations/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.violationsAll],
      onDone: () => {
        toast.show(t('cancelledToast'));
        setStep(null);
      },
    },
  );
  const reverse = useAction(
    (input: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/violation-payments/{id}/reverse', { params: { path: { id: input.id } }, body: { reasonCode: input.reasonCode } })),
    {
      invalidate: [keys.violationsAll],
      onDone: () => {
        toast.show(t('reversedToast'));
        setReversing(null);
      },
    },
  );
  const v = violation.data;
  const actions = v ? violationActions(v, { manage: can('violations.manage'), billing: can('fines.billing') }) : [];
  const reversed = new Set((v?.payments ?? []).filter((p) => p.kind === 'reversal').map((p) => p.reversesId));
  return (
    <>
      <Dialog
        open={step === null || step === 'cancel' || step === 'accept'}
        wide
        onClose={onClose}
        title={v ? t('detailTitle', { reference: v.reference, unit: v.unitCode }) : t('violation')}
        description={
          v ? [label(v.kind), v.amount ? f.money(v.amount) : t('warning'), f.day(v.date)].join(' · ') : undefined
        }
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
                {t('cancelViolation')}
              </Button>
            ) : null}
            <Button onClick={onClose}>{c('close')}</Button>
          </>
        }
      >
        <QueryState query={violation} rows={4}>
          {v ? (
            <div className="stack">
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={v.status} />
                  {v.cancelReason ? <span className="t-secondary"> · {label(v.cancelReason)}</span> : null}
                </dd>
                <dt>{t('issuedAt')}</dt>
                <dd>
                  {t('issuedBy', { when: f.dateTime(v.createdAt), name: personNameIn(v.issuedBy, locale) })}
                  {v.post ? t('onShift', { post: postNameIn(v.post, locale) }) : ''}
                </dd>
                {v.permitReference ? (
                  <>
                    <dt>{t('worksPermit')}</dt>
                    <dd className="t-mono ltr">{v.permitReference}</dd>
                  </>
                ) : null}
                {v.note ? (
                  <>
                    <dt>{t('noteForUnit')}</dt>
                    <dd>{v.note}</dd>
                  </>
                ) : null}
              </dl>
              {v.photoUrl ? (
                <a className="btn btn--secondary btn--sm" href={v.photoUrl} target="_blank" rel="noreferrer">
                  {t('openPhoto')}
                </a>
              ) : null}
              {v.appeal ? (
                <Card>
                  <div className="stack stack--sm" style={{ padding: 16 }}>
                    <strong>{t('appeal')}</strong>
                    <span className="t-secondary">
                      {t('appealBy', { when: f.dateTime(v.appeal.appealedAt), name: personNameIn(v.appealedBy, locale) })}
                    </span>
                    <span>{v.appeal.reason ?? <span className="t-secondary">{t('appealErased')}</span>}</span>
                    {v.appeal.photoUrl ? (
                      <a href={v.appeal.photoUrl} target="_blank" rel="noreferrer">
                        {t('appealPhoto')}
                      </a>
                    ) : null}
                    {v.appeal.decision ? (
                      <Badge tone={v.appeal.decision === 'upheld' ? 'beige' : 'green'}>
                        {t(v.appeal.decision === 'upheld' ? 'decisionUpheld' : 'decisionAccepted', { name: personNameIn(v.decidedBy, locale) })}
                      </Badge>
                    ) : null}
                  </div>
                </Card>
              ) : null}
              {v.isWarning ? null : (
                <Card flush>
                  <DataTable<ViolationPayment>
                    rows={v.payments}
                    rowKey={(p) => p.id}
                    empty={t('noPayment')}
                    columns={[
                      {
                        key: 'kind',
                        header: '',
                        cell: (p) =>
                          p.kind === 'reversal' ? <Badge tone="error">{t('reversal')}</Badge> : reversed.has(p.id) ? <Badge tone="beige">{t('reversed')}</Badge> : <Badge tone="green">{t('payment')}</Badge>,
                      },
                      { key: 'paid', header: t('paidOn'), cell: (p) => (p.paidOn ? f.day(p.paidOn) : f.date(p.createdAt)) },
                      { key: 'amount', header: c('amount'), cell: (p) => (p.amount ? f.money(p.amount) : label(p.reasonCode)) },
                      { key: 'receipt', header: t('receipt'), cell: (p) => <span className="t-mono ltr">{p.receiptNumber ?? '—'}</span> },
                      { key: 'by', header: c('by'), cell: (p) => personNameIn(p.recordedBy, locale) },
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
              )}
              <ErrorAlert error={decide.error} />
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {v && step === 'pay' ? <RecordPayment violation={v} onClose={() => setStep(null)} /> : null}
      <ReasonCodeDialog
        open={step === 'accept'}
        onClose={() => setStep(null)}
        title={t('acceptTitle', { reference: v?.reference ?? '' })}
        description={t('acceptDescription')}
        codes={['appeal_accepted']}
        confirmLabel={t('acceptConfirm')}
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ decision: 'cancelled', reasonCode })}
      />
      <ReasonCodeDialog
        open={step === 'cancel'}
        onClose={() => setStep(null)}
        title={t('cancelTitle', { reference: v?.reference ?? '' })}
        description={t('cancelDescription')}
        codes={REASON_CODES.violationCancel.filter((code) => code !== 'appeal_accepted')}
        confirmLabel={t('cancelViolation')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
      <ReasonCodeDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        title={t('reverseTitle', { receipt: reversing?.receiptNumber ?? '' })}
        description={t('reverseDescription')}
        codes={REASON_CODES.violationPaymentReverse}
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
 * Violations (ADR 0053), as the fines: issued to a unit by a guard on shift
 * or the office (`violations.issue`), appealed once by its people, decided
 * and cancelled by `violations.manage`, paid at the office
 * (`fines.billing`). The unit never sees who issued one.
 */
export default function ViolationsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('violations.manage') || can('violations.issue') || can('fines.billing');
  const [status, setStatus] = useState<Status>(can('violations.manage') ? 'under_appeal' : 'open');
  const [kind, setKind] = useState('');
  const [unitCode, setUnitCode] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('violation');
    if (linked) setOpen(linked);
  }, []);
  const filters: ViolationFilters = { status, kind: kind as ViolationFilters['kind'], unitCode: unitCode.trim() };
  const list = useCursorList(keys.violations(filters), (c) => fetchers.violations(filters, c), { enabled: allowed });
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
          can('violations.issue') ? (
            <Button variant="primary" onClick={() => setIssuing(true)}>
              {t('issueButton')}
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<Status>
          label={t('shown')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'under_appeal', label: t('view.under_appeal') },
            { value: 'open', label: t('view.open') },
            { value: 'paid', label: t('view.paid') },
            { value: 'cancelled', label: t('view.cancelled') },
            { value: '', label: t('view.all') },
          ]}
        />
        <Field label={c('kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{t('everyKind')}</option>
              {REASON_CODES.violationKind.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('unitCode')}>
          {(p) => <Input {...p} className="ltr" placeholder={t('unitCodePlaceholder')} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffViolation>
            rows={list.rows}
            rowKey={(v) => v.id}
            empty={status === 'under_appeal' ? t('emptyAppeals') : t('empty')}
            columns={[
              {
                key: 'ref',
                header: t('violation'),
                cell: (v) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(v.id)}>
                    {v.reference}
                  </Button>
                ),
              },
              { key: 'unit', header: c('unit'), cell: (v) => <span className="t-mono ltr">{v.unitCode}</span> },
              { key: 'kind', header: c('kind'), cell: (v) => label(v.kind) },
              {
                key: 'amount',
                header: c('amount'),
                cell: (v) => (v.amount ? f.money(v.amount) : <Badge tone="beige">{t('warning')}</Badge>),
              },
              { key: 'status', header: c('status'), cell: (v) => <StatusBadge status={v.status} /> },
              { key: 'when', header: t('issued'), cell: (v) => <span title={f.dateTime(v.createdAt)}>{f.relative(v.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <ViolationDetail id={open} onClose={() => setOpen(null)} /> : null}
      {issuing ? <IssueViolation onClose={() => setIssuing(false)} /> : null}
    </>
  );
}
