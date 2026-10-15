'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { egp } from '@/components/club/logic';
import { validReceipt } from '@/components/facilities/logic';
import { FineDialog, type FineBody } from '@/components/vehicles/fine-dialog';
import { fineActions } from '@/components/vehicles/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FineFilters, type FinePayment, type FineStatus, type StaffFine } from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');
const VIEWS = ['unpaid', 'under_appeal', 'paid', 'cancelled', 'all'] as const;
type View = (typeof VIEWS)[number];
const who = (a: { fullName?: string | null; erased?: true } | null) => (a ? (a.erased ? 'an erased account' : (a.fullName ?? '—')) : '—');

function RecordPayment({ fine, onClose }: { fine: StaffFine; onClose: () => void }) {
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
        toast.show('Payment recorded. The fine is paid.');
        onClose();
      },
    },
  );
  const ready = validReceipt(receiptNumber) && paidOn !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Record the payment of ${fine.reference}`}
      description={`The whole amount, ${egp(fine.amount)}, paid at the office. Records are never edited: a wrong one is reversed.`}
      onSubmit={() => ready && save.mutate()}
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
          hint="Recorded once among the compound’s fine payments."
          error={fieldError(save.error, 'receiptNumber') ?? (receiptNumber && !validReceipt(receiptNumber) ? 'Letters, digits, / and - only.' : undefined)}
        >
          {(p) => <Input {...p} maxLength={40} value={receiptNumber} onChange={(e) => setReceipt(e.target.value)} />}
        </Field>
        <Field label="Paid on" hint="Not before the fine’s day, at most 90 days ago." error={fieldError(save.error, 'paidOn')}>
          {(p) => <Input {...p} type="date" min={fine.occurredOn} max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function FineDetail({ id, onClose }: { id: string; onClose: () => void }) {
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
        toast.show(f.status === 'cancelled' ? 'Appeal accepted: the fine is cancelled.' : 'Appeal upheld: the fine stands.');
        setStep(null);
      },
    },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/staff/vehicle-fines/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.finesAll],
      onDone: () => {
        toast.show('Cancelled.');
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
        toast.show('Reversed. The fine is unpaid again.');
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
        title={f ? `${f.reference} · unit ${f.unitCode}` : 'Fine'}
        description={f ? `${humanize(f.reason)} · ${egp(f.amount)} · ${f.occurredOn}` : undefined}
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
                Cancel the fine
              </Button>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <QueryState query={fine} rows={4}>
          {f ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={f.status} />
                  {f.cancelReason ? <span className="t-secondary"> · {humanize(f.cancelReason)}</span> : null}
                </dd>
                <dt>Plate</dt>
                <dd>{f.plate}</dd>
                <dt>Issued</dt>
                <dd>
                  {formatDateTime(f.createdAt)} · by {who(f.issuedBy)}
                </dd>
                {f.note ? (
                  <>
                    <dt>Note for the unit</dt>
                    <dd>{f.note}</dd>
                  </>
                ) : null}
              </dl>
              {f.photoUrl ? (
                <a className="btn btn--secondary btn--sm" href={f.photoUrl} target="_blank" rel="noreferrer">
                  Open the photo
                </a>
              ) : null}
              {f.appeal ? (
                <Card>
                  <div className="stack stack--sm" style={{ padding: 16 }}>
                    <strong>Appeal</strong>
                    <span className="t-secondary">
                      {formatDateTime(f.appeal.appealedAt)} · by {who(f.appealedBy)}
                    </span>
                    <span>{f.appeal.reason ?? <span className="t-secondary">The appellant’s words were erased.</span>}</span>
                    {f.appeal.photoUrl ? (
                      <a href={f.appeal.photoUrl} target="_blank" rel="noreferrer">
                        The appeal’s photo
                      </a>
                    ) : null}
                    {f.appeal.decision ? (
                      <Badge tone={f.appeal.decision === 'upheld' ? 'beige' : 'green'}>
                        {f.appeal.decision === 'upheld' ? 'Upheld' : 'Accepted'} · {who(f.decidedBy)}
                      </Badge>
                    ) : null}
                  </div>
                </Card>
              ) : null}
              <Card flush>
                <DataTable<FinePayment>
                  rows={f.payments}
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
                    { key: 'by', header: 'By', cell: (p) => who(p.recordedBy) },
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
              <ErrorAlert error={decide.error} />
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {f && step === 'pay' ? <RecordPayment fine={f} onClose={() => setStep(null)} /> : null}
      <ReasonCodeDialog
        open={step === 'accept'}
        onClose={() => setStep(null)}
        title={`Accept the appeal of ${f?.reference ?? ''}?`}
        description="The fine is cancelled and the appellant is told."
        codes={REASON_CODES.vehicleFineCancel}
        confirmLabel="Accept and cancel"
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ decision: 'cancelled', reasonCode })}
      />
      <ReasonCodeDialog
        open={step === 'cancel'}
        onClose={() => setStep(null)}
        title={`Cancel ${f?.reference ?? ''}?`}
        description="Final. The unit sees it cancelled, with the reason."
        codes={REASON_CODES.vehicleFineCancel.filter((c) => c !== 'appeal_accepted')}
        confirmLabel="Cancel the fine"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
      <ReasonCodeDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        title={`Reverse receipt ${reversing?.receiptNumber ?? ''}?`}
        description="A new record cancels this one; nothing is edited. The fine is unpaid again."
        codes={REASON_CODES.vehicleFinePaymentReverse}
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
 * Vehicle fines (ADR 0045): issued to a unit, appealed once by its people,
 * decided by the staff, and paid at the office (`fines.billing`, the
 * accountant). The unit never sees where a fine came from.
 */
export default function FinesPage() {
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
        toast.show(`Issued ${f.reference}. The unit is told.`);
        setIssuing(false);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Fines" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Fines"
        description="Paid at the office: no online payment yet."
        actions={
          can('fines.issue') ? (
            <Button variant="primary" onClick={() => setIssuing(true)}>
              Issue a fine
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label="Fines shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'under_appeal', label: 'Appeals' },
            { value: 'unpaid', label: 'Unpaid' },
            { value: 'paid', label: 'Paid' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Field label="Unit code">
          {(p) => <Input {...p} placeholder="e.g. A-101" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffFine>
            rows={list.rows}
            rowKey={(f) => f.id}
            empty={view === 'under_appeal' ? 'No appeal waits' : 'No fine matches'}
            columns={[
              {
                key: 'ref',
                header: 'Fine',
                cell: (f) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(f.id)}>
                    {f.reference}
                  </Button>
                ),
              },
              { key: 'unit', header: 'Unit', cell: (f) => <span className="t-mono">{f.unitCode}</span> },
              { key: 'plate', header: 'Plate', cell: (f) => f.plate },
              { key: 'reason', header: 'Reason', cell: (f) => humanize(f.reason) },
              { key: 'amount', header: 'Amount', cell: (f) => egp(f.amount) },
              { key: 'status', header: 'Status', cell: (f) => <StatusBadge status={f.status} /> },
              { key: 'when', header: 'Issued', cell: (f) => <span title={formatDateTime(f.createdAt)}>{relativeTime(f.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <FineDetail id={open} onClose={() => setOpen(null)} /> : null}
      {issuing ? (
        <FineDialog
          title="Issue a fine"
          description="The unit’s vehicle keepers and its primary are told, with the reason only."
          confirmLabel="Issue"
          pending={issue.isPending}
          error={issue.error}
          onSubmit={(body) => issue.mutate(body)}
          onClose={() => setIssuing(false)}
        />
      ) : null}
    </>
  );
}
