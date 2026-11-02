'use client';

import { ApiError, errorText, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, DataTable, Dialog, Field, PageHeader, ReasonCodeDialog, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';

type Transfer = Schema<'OwnershipTransferView'>;
const VIEWS = ['pending', 'done', 'cancelled'] as const;
type View = (typeof VIEWS)[number];
const KEY = ['ownership-transfers'] as const;
const words = (code: string) => code.replace(/_/g, ' ');

/**
 * Ownership transfers (ADR 0083): requested from a unit's page, approved
 * here once. A unit that owes the compound is not transferred; an
 * exception needs a reason and a fresh code to your email, and is audited
 * with what was owed.
 */
export default function OwnershipTransfersPage() {
  const toast = useToast();
  const [view, setView] = useState<View>('pending');
  const [approving, setApproving] = useState<Transfer | null>(null);
  const [cancelling, setCancelling] = useState<Transfer | null>(null);
  const list = useQuery({
    queryKey: [...KEY, view],
    queryFn: () => unwrap(api.GET('/api/v1/staff/ownership-transfers', { params: { query: { status: view } } })),
  });
  const cancel = useAction(
    (v: { t: Transfer; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/ownership-transfers/{id}/cancel', {
          params: { path: { id: v.t.id } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Transfer cancelled.');
        setCancelling(null);
      },
    },
  );
  return (
    <>
      <PageHeader
        title="Ownership transfers"
        description="Units changing hands. Request one from the unit’s page; approve it here once its dues are checked."
      />
      <Segmented<View>
        label="Show"
        value={view}
        onChange={setView}
        options={VIEWS.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Transfer>
            rows={list.data?.data}
            rowKey={(t) => t.id}
            empty="No transfer here"
            emptyHint="Request one from a unit’s page: Transfer ownership."
            columns={[
              { key: 'ref', header: 'Transfer', cell: (t) => <span className="t-mono">{t.reference}</span> },
              {
                key: 'unit',
                header: 'Unit',
                cell: (t) => (
                  <Link className="table__link" href={`/units/${t.unitId}`}>
                    {t.unitCode}
                  </Link>
                ),
              },
              { key: 'buyer', header: 'New owner', cell: (t) => t.buyerName ?? '—' },
              { key: 'asked', header: 'Requested', cell: (t) => formatDateTime(t.requestedAt) },
              {
                key: 'owed',
                header: 'Owed',
                cell: (t) => {
                  const owed = t.status === 'pending' ? t.owedNow : t.owedAtApproval;
                  if (owed === null) return '—';
                  return Number(owed) > 0 ? <Badge tone="terracotta">{owed} EGP</Badge> : <span className="t-secondary">Nothing</span>;
                },
              },
              {
                key: 'act',
                header: '',
                cell: (t) =>
                  t.status === 'pending' ? (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" variant="primary" onClick={() => setApproving(t)}>
                        Approve
                      </Button>
                      <Button size="sm" onClick={() => setCancelling(t)}>
                        Cancel
                      </Button>
                    </span>
                  ) : t.duesExceptionCode ? (
                    <span className="t-secondary">Exception: {words(t.duesExceptionCode)}</span>
                  ) : (
                    <span className="t-secondary">{t.cancelReason ? words(t.cancelReason) : t.status}</span>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {approving ? <ApproveDialog transfer={approving} onClose={() => setApproving(null)} /> : null}
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel the transfer"
        description="Nothing changes on the unit."
        codes={REASON_CODES.ownershipTransferCancel}
        confirmLabel="Cancel the transfer"
        danger
        pending={cancel.isPending}
        error={cancel.error ? errorText(cancel.error) : undefined}
        onConfirm={(reasonCode) => cancelling && cancel.mutate({ t: cancelling, reasonCode })}
      />
    </>
  );
}

/**
 * Approves a transfer: at once when the unit owes nothing; else, as an
 * exception, with a reason and a fresh code (the step-up).
 */
function ApproveDialog({ transfer, onClose }: { transfer: Transfer; onClose: () => void }) {
  const toast = useToast();
  const owes = Number(transfer.owedNow ?? '0') > 0;
  const [exception, setException] = useState('');
  const [stepping, setStepping] = useState(false);
  const approve = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/ownership-transfers/{id}/approve', {
          params: { path: { id: transfer.id } },
          body: exception
            ? { duesExceptionCode: exception as (typeof REASON_CODES.transferDuesException)[number] }
            : {},
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Ownership transferred. The previous occupancies and household have ended; each person is told.');
        onClose();
      },
    },
  );
  const owedNow =
    approve.error instanceof ApiError && approve.error.code === 'TRANSFER_DUES_OWED'
      ? String((approve.error.params as { owed?: string } | undefined)?.owed ?? transfer.owedNow)
      : transfer.owedNow;
  if (stepping)
    return (
      <StepUpDialog
        title="Confirm it is you"
        description="Transferring a unit that owes the compound is an exception: we sent a code to your email."
        onClose={() => setStepping(false)}
        onVerified={() => {
          setStepping(false);
          approve.mutate(undefined);
        }}
      />
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Approve ${transfer.reference}?`}
      description={`Unit ${transfer.unitCode} passes to ${transfer.buyerName ?? 'the new owner'}. Every current occupancy and the household end; this cannot be undone.`}
      onSubmit={() => (owes ? setStepping(true) : approve.mutate(undefined))}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={approve.isPending} disabled={owes && exception === ''}>
            {owes ? 'Approve as an exception' : 'Approve the transfer'}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={approve.error} />
        {owes ? (
          <>
            <Alert tone="warn">
              The unit owes {owedNow} EGP. It is not transferred unless you approve it as an exception, with a reason.
            </Alert>
            <Field label="Why it goes ahead">
              {(p) => (
                <Select {...p} value={exception} onChange={(e) => setException(e.target.value)}>
                  <option value="">Select a reason…</option>
                  {REASON_CODES.transferDuesException.map((c) => (
                    <option key={c} value={c}>
                      {words(c)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : (
          <p className="t-secondary">The unit owes nothing.</p>
        )}
      </div>
    </Dialog>
  );
}
