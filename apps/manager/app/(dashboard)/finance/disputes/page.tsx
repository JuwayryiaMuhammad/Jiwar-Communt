'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { egp } from '@/components/club/logic';
import { validMoney } from '@/components/finance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffDispute } from '@/lib/queries';

type View = 'open' | 'accepted' | 'rejected' | 'all';

function DisputeDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const dispute = useQuery({ queryKey: keys.dispute(id), queryFn: () => fetchers.dispute(id) });
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [amount, setAmount] = useState('');
  const decide = useAction(
    (body: { decision: 'accept'; amount: string } | { decision: 'reject'; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/invoice-disputes/{id}/decide', { params: { path: { id } }, body })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (d) => {
        toast.show(
          d.status === 'accepted'
            ? `Accepted: ${egp(d.decision?.creditedAmount ?? '0')} credited (${d.decision?.creditNoteNumber ?? ''}). The resident was told.`
            : 'Rejected. The resident was told; the invoice is no longer frozen.',
        );
        setAccepting(false);
        setRejecting(false);
      },
    },
  );
  const d = dispute.data;
  const open = d?.status === 'open';
  return (
    <>
      <Dialog
        open={!accepting && !rejecting}
        wide
        onClose={onClose}
        title={d ? `Dispute of ${d.invoiceNumber} · unit ${d.unitCode}` : 'Dispute'}
        description={d ? `${humanize(d.reasonCode)} · opened ${formatDateTime(d.createdAt)}` : undefined}
        footer={
          <>
            {open ? (
              <>
                <Button variant="danger" onClick={() => setRejecting(true)}>
                  Reject
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setAmount(Number(d.outstanding) > 0 ? d.outstanding : '');
                    setAccepting(true);
                  }}
                >
                  Accept
                </Button>
              </>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <QueryState query={dispute} rows={4}>
          {d ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={d.status} />
                </dd>
                <dt>Invoice owes now</dt>
                <dd>{egp(d.outstanding)}</dd>
                <dt>The resident’s words</dt>
                <dd>{d.cleared ? <span className="t-secondary">Erased with the resident’s account</span> : (d.text ?? '—')}</dd>
                {d.decision ? (
                  <>
                    <dt>Decision</dt>
                    <dd>
                      {d.decision.creditNoteNumber
                        ? `Credited ${egp(d.decision.creditedAmount ?? '0')} (${d.decision.creditNoteNumber})`
                        : humanize(d.decision.reasonCode ?? '')}{' '}
                      · {formatDateTime(d.decision.decidedAt)}
                    </dd>
                  </>
                ) : null}
              </dl>
              {d.photoUrl ? (
                // A short-lived link to the resident's photo, never stored.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={d.photoUrl} alt="The resident’s photo" style={{ maxWidth: '100%', borderRadius: 8 }} />
              ) : null}
              {open ? (
                <p className="t-secondary">
                  While open the invoice is frozen: no reminder, no payment naming it, and the unit’s credit does not pay it.
                </p>
              ) : null}
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <Dialog
        open={accepting}
        onClose={() => setAccepting(false)}
        title="Accept the dispute"
        description="A credit note takes the amount off the invoice. Beyond what it still owes, paid money goes back to the unit’s credit."
        onSubmit={() => validMoney(amount) && decide.mutate({ decision: 'accept', amount: amount.trim() })}
        footer={
          <>
            <Button onClick={() => setAccepting(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={decide.isPending} disabled={!validMoney(amount)}>
              Accept and credit
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Credit, EGP" error={fieldError(decide.error, 'amount')}>
            {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <ErrorAlert error={decide.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject the dispute?"
        description="The invoice stands and is no longer frozen. The resident is told."
        codes={REASON_CODES.invoiceDisputeReject}
        confirmLabel="Reject"
        danger
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ decision: 'reject', reasonCode })}
      />
    </>
  );
}

function Disputes() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const params = useSearchParams();
  const [view, setView] = useState<View>('open');
  const [open, setOpen] = useState<string | null>(params.get('open'));
  const status = view === 'all' ? '' : view;
  const list = useCursorList(keys.disputes(status), (c) => fetchers.disputes(status, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Disputes" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Disputes" description="Residents’ disputes of invoices. Each is decided once; the resident who opened it is told." />
      <div className="toolbar">
        <Segmented<View>
          label="Disputes shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffDispute>
            rows={list.rows}
            rowKey={(d) => d.id}
            empty="No dispute"
            columns={[
              {
                key: 'i',
                header: 'Invoice',
                cell: (d) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(d.id)}>
                    {d.invoiceNumber}
                  </Button>
                ),
              },
              {
                key: 'u',
                header: 'Unit',
                cell: (d) => (
                  <Link className="t-mono" href={`/finance/units/${d.unitId}`}>
                    {d.unitCode}
                  </Link>
                ),
              },
              { key: 'r', header: 'Reason', cell: (d) => humanize(d.reasonCode) },
              { key: 'o', header: 'Owed', cell: (d) => egp(d.outstanding) },
              { key: 's', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
              { key: 'w', header: 'Opened', cell: (d) => <span title={formatDateTime(d.createdAt)}>{relativeTime(d.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <DisputeDialog id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** Invoice disputes (ADR 0048). */
export default function DisputesPage() {
  return (
    <Suspense>
      <Disputes />
    </Suspense>
  );
}
