'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, ForbiddenState, PageHeader, ReasonCodeDialog, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { ApprovalPackage } from '@/components/governance/board-ui';
import { APPROVAL_TYPE_TEXT } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

function MarkImplemented({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const mark = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/governance/approvals/{id}/implemented', {
          params: { path: { id } },
          body: note.trim() ? { note: note.trim() } : {},
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('Marked implemented. The board was told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Mark it implemented?"
      description="Once: the board sees when, and your note."
      onSubmit={() => mark.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={mark.isPending}>
            Mark implemented
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Note (optional)" error={fieldError(mark.error, 'note')}>
          {(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <ErrorAlert error={mark.error} />
      </div>
    </Dialog>
  );
}

/** One request as the management follows it (ADR 0055): the package and the board’s decision, never the deliberation. */
export default function ApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.approvals');
  const q = useQuery({ queryKey: keys.approval(id), queryFn: () => fetchers.approval(id), enabled: allowed });
  const [withdrawing, setWithdrawing] = useState(false);
  const [marking, setMarking] = useState(false);
  const withdraw = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/governance/approvals/{id}/withdraw', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.governanceAll, keys.budgetsAll],
      onDone: () => {
        toast.show('Withdrawn. Any open motion on it closed; the board was told.');
        setWithdrawing(false);
      },
    },
  );
  const back = <Back href="/governance/approvals" label="Approvals" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Request" />
        <ForbiddenState />
      </>
    );
  const a = q.data;
  const mayWithdraw = a?.status === 'pending' && (a.raisedByMe || can('governance.manage'));
  const mayMark = a?.status === 'approved' && !a.implementation && can('governance.manage');
  return (
    <>
      <PageHeader
        back={back}
        title={a ? `${a.reference} · ${APPROVAL_TYPE_TEXT[a.type]}` : 'Request'}
        actions={
          <>
            {mayMark ? (
              <Button variant="primary" onClick={() => setMarking(true)}>
                Mark implemented
              </Button>
            ) : null}
            {mayWithdraw ? (
              <Button variant="danger" onClick={() => setWithdrawing(true)}>
                Withdraw
              </Button>
            ) : null}
          </>
        }
      />
      <QueryState query={q}>{a ? <ApprovalPackage a={a} /> : null}</QueryState>
      <ReasonCodeDialog
        open={withdrawing}
        onClose={() => setWithdrawing(false)}
        title="Withdraw the request?"
        description="The board stops deciding it; a submitted budget goes back to withdrawn, and a new one is drafted."
        codes={REASON_CODES.approvalWithdraw}
        confirmLabel="Withdraw"
        danger
        pending={withdraw.isPending}
        error={<ErrorAlert error={withdraw.error} />}
        onConfirm={(code) => withdraw.mutate(code)}
      />
      {marking ? <MarkImplemented id={id} onClose={() => setMarking(false)} /> : null}
    </>
  );
}
