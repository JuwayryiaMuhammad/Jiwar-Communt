'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, relativeTime, unwrap, type Schema } from '@jiwar/api';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { egp } from '@/components/club/logic';
import { validReceipt } from '@/components/facilities/logic';
import { FileUpload } from '@/components/file-upload';
import { personName, postName } from '@/components/security/logic';
import { violationActions } from '@/components/security/ops-logic';
import { addDays, validFineAmount } from '@/components/vehicles/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffViolation, type ViolationFilters, type ViolationPayment } from '@/lib/queries';

type Body = Schema<'IssueViolationDto'>;
type Status = NonNullable<ViolationFilters['status']>;

const today = () => new Date().toLocaleDateString('en-CA');
const amountText = (v: { amount: string | null }) => (v.amount ? egp(v.amount) : <Badge tone="beige">Warning</Badge>);

function IssueViolation({ onClose }: { onClose: () => void }) {
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
      toast.show(`Issued ${v.reference}. The unit is told.`);
      onClose();
    },
  });
  const ready = kind !== '' && (hours ? permitId.trim() !== '' || unitCode.trim() !== '' : unitCode.trim() !== '') && occurredOn !== '' && (!amount.trim() || validFineAmount(amount));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Issue a violation"
      description="To a unit, with an amount or none (a warning). Its keepers and its primary are told by the kind alone."
      onSubmit={() => ready && issue.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={issue.isPending} disabled={!ready}>
            Issue
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Kind" error={fieldError(issue.error, 'kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Select…</option>
              {REASON_CODES.violationKind.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {hours ? (
          <Field label="Works permit" hint="The permit’s id: the unit is the permit’s. Or give the unit’s code below." error={fieldError(issue.error, 'permitId')}>
            {(p) => <Input {...p} value={permitId} onChange={(e) => setPermitId(e.target.value)} />}
          </Field>
        ) : null}
        {!hours || !permitId.trim() ? (
          <Field label="Unit code" error={fieldError(issue.error, 'unitCode')}>
            {(p) => <Input {...p} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
          </Field>
        ) : null}
        <Field
          label="Amount, EGP"
          hint="Empty: a warning, never paid."
          error={fieldError(issue.error, 'amount') ?? (amount && !validFineAmount(amount) ? 'More than zero, at most 100,000, two decimals.' : undefined)}
        >
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Day it happened" hint="Within the last 90 days." error={fieldError(issue.error, 'occurredOn')}>
          {(p) => <Input {...p} type="date" min={addDays(today(), -90)} max={today()} value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />}
        </Field>
        <Field label="Note for the unit" hint="Optional. The unit’s people read it." error={fieldError(issue.error, 'note')}>
          {(p) => <Textarea {...p} maxLength={500} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Field label="Photo">
          {() =>
            photoFileId ? (
              <span className="row" style={{ gap: 8 }}>
                <span className="t-secondary">Photo attached.</span>
                <Button size="sm" onClick={() => setPhoto(null)}>
                  Remove
                </Button>
              </span>
            ) : (
              <FileUpload purpose="violation_photo" label="Add a photo" onUploaded={setPhoto} />
            )
          }
        </Field>
        <ErrorAlert error={issue.error} />
      </div>
    </Dialog>
  );
}

function RecordPayment({ violation, onClose }: { violation: StaffViolation; onClose: () => void }) {
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
        toast.show('Payment recorded. The violation is paid.');
        onClose();
      },
    },
  );
  const ready = validReceipt(receiptNumber) && paidOn !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Record the payment of ${violation.reference}`}
      description={`The whole amount, ${violation.amount ? egp(violation.amount) : ''}, paid at the office. Records are never edited: a wrong one is reversed.`}
      onSubmit={() => ready && save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="form">
        <Field
          label="Receipt number"
          hint="Recorded once among the compound’s violation payments."
          error={fieldError(save.error, 'receiptNumber') ?? (receiptNumber && !validReceipt(receiptNumber) ? 'Letters, digits, / and - only.' : undefined)}
        >
          {(p) => <Input {...p} maxLength={40} value={receiptNumber} onChange={(e) => setReceipt(e.target.value)} />}
        </Field>
        <Field label="Paid on" hint="Not before the violation’s day, at most 90 days ago." error={fieldError(save.error, 'paidOn')}>
          {(p) => <Input {...p} type="date" min={violation.date} max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function ViolationDetail({ id, onClose }: { id: string; onClose: () => void }) {
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
        toast.show(v.status === 'cancelled' ? 'Appeal accepted: the violation is cancelled.' : 'Appeal upheld: the violation stands.');
        setStep(null);
      },
    },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/violations/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.violationsAll],
      onDone: () => {
        toast.show('Cancelled.');
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
        toast.show('Reversed. The violation is open again.');
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
        title={v ? `${v.reference} · unit ${v.unitCode}` : 'Violation'}
        description={v ? `${humanize(v.kind)} · ${v.amount ? egp(v.amount) : 'a warning'} · ${v.date}` : undefined}
        footer={
          <>
            {actions.includes('decide') ? (
              <>
                <Button loading={decide.isPending} onClick={() => decide.mutate({ decision: 'upheld' })}>
                  Uphold
                </Button>
                <Button variant="primary" onClick={() => setStep('accept')}>
                  Accept the appeal
                </Button>
              </>
            ) : null}
            {actions.includes('pay') ? (
              <Button variant="primary" onClick={() => setStep('pay')}>
                Record payment
              </Button>
            ) : null}
            {actions.includes('cancel') ? (
              <Button variant="danger" onClick={() => setStep('cancel')}>
                Cancel the violation
              </Button>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <QueryState query={violation} rows={4}>
          {v ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={v.status} />
                  {v.cancelReason ? <span className="t-secondary"> · {humanize(v.cancelReason)}</span> : null}
                </dd>
                <dt>Issued</dt>
                <dd>
                  {formatDateTime(v.createdAt)} · by {personName(v.issuedBy)}
                  {v.post ? ` · on shift at ${postName(v.post)}` : ''}
                </dd>
                {v.permitReference ? (
                  <>
                    <dt>Works permit</dt>
                    <dd className="t-mono">{v.permitReference}</dd>
                  </>
                ) : null}
                {v.note ? (
                  <>
                    <dt>Note for the unit</dt>
                    <dd>{v.note}</dd>
                  </>
                ) : null}
              </dl>
              {v.photoUrl ? (
                <a className="btn btn--secondary btn--sm" href={v.photoUrl} target="_blank" rel="noreferrer">
                  Open the photo
                </a>
              ) : null}
              {v.appeal ? (
                <Card>
                  <div className="stack stack--sm" style={{ padding: 16 }}>
                    <strong>Appeal</strong>
                    <span className="t-secondary">
                      {formatDateTime(v.appeal.appealedAt)} · by {personName(v.appealedBy)}
                    </span>
                    <span>{v.appeal.reason ?? <span className="t-secondary">The appellant’s words were erased.</span>}</span>
                    {v.appeal.photoUrl ? (
                      <a href={v.appeal.photoUrl} target="_blank" rel="noreferrer">
                        The appeal’s photo
                      </a>
                    ) : null}
                    {v.appeal.decision ? (
                      <Badge tone={v.appeal.decision === 'upheld' ? 'beige' : 'green'}>
                        {v.appeal.decision === 'upheld' ? 'Upheld' : 'Accepted'} · {personName(v.decidedBy)}
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
                    empty="No payment"
                    columns={[
                      {
                        key: 'kind',
                        header: '',
                        cell: (p) =>
                          p.kind === 'reversal' ? <Badge tone="error">Reversal</Badge> : reversed.has(p.id) ? <Badge tone="beige">Reversed</Badge> : <Badge tone="green">Payment</Badge>,
                      },
                      { key: 'paid', header: 'Paid on', cell: (p) => p.paidOn ?? new Date(p.createdAt).toLocaleDateString('en-CA') },
                      { key: 'amount', header: 'Amount', cell: (p) => (p.amount ? egp(p.amount) : humanize(p.reasonCode)) },
                      { key: 'receipt', header: 'Receipt', cell: (p) => <span className="t-mono">{p.receiptNumber ?? '—'}</span> },
                      { key: 'by', header: 'By', cell: (p) => personName(p.recordedBy) },
                      {
                        key: 'actions',
                        header: '',
                        className: 'table__actions',
                        cell: (p) =>
                          p.kind === 'payment' && !reversed.has(p.id) && can('fines.billing') ? (
                            <Button size="sm" onClick={() => setReversing(p)}>
                              Reverse
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
        title={`Accept the appeal of ${v?.reference ?? ''}?`}
        description="The violation is cancelled and the appellant is told."
        codes={['appeal_accepted']}
        confirmLabel="Accept and cancel"
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ decision: 'cancelled', reasonCode })}
      />
      <ReasonCodeDialog
        open={step === 'cancel'}
        onClose={() => setStep(null)}
        title={`Cancel ${v?.reference ?? ''}?`}
        description="Final. The unit sees it cancelled, with the reason."
        codes={REASON_CODES.violationCancel.filter((c) => c !== 'appeal_accepted')}
        confirmLabel="Cancel the violation"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
      <ReasonCodeDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        title={`Reverse receipt ${reversing?.receiptNumber ?? ''}?`}
        description="A new record cancels this one; nothing is edited. The violation is open again."
        codes={REASON_CODES.violationPaymentReverse}
        confirmLabel="Reverse"
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
        <PageHeader title="Violations" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Violations"
        description="Noise, waste, pets, contractor hours and others, issued to a unit. Paid at the office: no online payment yet."
        actions={
          can('violations.issue') ? (
            <Button variant="primary" onClick={() => setIssuing(true)}>
              Issue a violation
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<Status>
          label="Violations shown"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'under_appeal', label: 'Appeals' },
            { value: 'open', label: 'Open' },
            { value: 'paid', label: 'Paid' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: '', label: 'All' },
          ]}
        />
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Every kind</option>
              {REASON_CODES.violationKind.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Unit code">
          {(p) => <Input {...p} placeholder="e.g. A-101" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffViolation>
            rows={list.rows}
            rowKey={(v) => v.id}
            empty={status === 'under_appeal' ? 'No appeal waits' : 'No violation matches'}
            columns={[
              {
                key: 'ref',
                header: 'Violation',
                cell: (v) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(v.id)}>
                    {v.reference}
                  </Button>
                ),
              },
              { key: 'unit', header: 'Unit', cell: (v) => <span className="t-mono">{v.unitCode}</span> },
              { key: 'kind', header: 'Kind', cell: (v) => humanize(v.kind) },
              { key: 'amount', header: 'Amount', cell: (v) => amountText(v) },
              { key: 'status', header: 'Status', cell: (v) => <StatusBadge status={v.status} /> },
              { key: 'when', header: 'Issued', cell: (v) => <span title={formatDateTime(v.createdAt)}>{relativeTime(v.createdAt)}</span> },
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
