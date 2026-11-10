'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, ForbiddenState, PageHeader, ReasonCodeDialog, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { ApprovalPackage } from '@/components/governance/board-ui';
import { codeText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/gov-approvals';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-approvals';
import codesEn from '@/messages/en/gov-codes';

function MarkImplemented({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('implementedToast'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('implementedTitle')}
      description={t('implementedDescription')}
      onSubmit={() => mark.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={mark.isPending}>
            {t('markImplemented')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('noteOptional')} error={fieldError(mark.error, 'note')}>
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
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
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
        toast.show(t('withdrawn'));
        setWithdrawing(false);
      },
    },
  );
  const back = <Back href="/governance/approvals" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('requestTitle')} />
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
        title={a ? `${a.reference} · ${codeText(g, 'approvalType', a.type)}` : t('requestTitle')}
        actions={
          <>
            {mayMark ? (
              <Button variant="primary" onClick={() => setMarking(true)}>
                {t('markImplemented')}
              </Button>
            ) : null}
            {mayWithdraw ? (
              <Button variant="danger" onClick={() => setWithdrawing(true)}>
                {t('withdraw')}
              </Button>
            ) : null}
          </>
        }
      />
      <QueryState query={q}>{a ? <ApprovalPackage a={a} /> : null}</QueryState>
      <ReasonCodeDialog
        open={withdrawing}
        onClose={() => setWithdrawing(false)}
        title={t('withdrawTitle')}
        description={t('withdrawDescription')}
        codes={REASON_CODES.approvalWithdraw}
        confirmLabel={t('withdraw')}
        danger
        pending={withdraw.isPending}
        error={<ErrorAlert error={withdraw.error} />}
        onConfirm={(code) => withdraw.mutate(code)}
      />
      {marking ? <MarkImplemented id={id} onClose={() => setMarking(false)} /> : null}
    </>
  );
}
