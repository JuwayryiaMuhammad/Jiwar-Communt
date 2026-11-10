'use client';

import { ApiError, ErrorText, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import ar from '@/messages/ar/res-ownership-transfers';
import en from '@/messages/en/res-ownership-transfers';

type Transfer = Schema<'OwnershipTransferView'>;
const VIEWS = ['pending', 'done', 'cancelled'] as const;
type View = (typeof VIEWS)[number];
const KEY = ['ownership-transfers'] as const;

/**
 * Ownership transfers (ADR 0083): requested from a unit's page, approved
 * here once. A unit that owes the compound is not transferred; an
 * exception needs a reason and a fresh code to your email, and is audited
 * with what was owed.
 */
export default function OwnershipTransfersPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [view, setView] = useState<View>('pending');
  const [approving, setApproving] = useState<Transfer | null>(null);
  const [cancelling, setCancelling] = useState<Transfer | null>(null);
  const list = useQuery({
    queryKey: [...KEY, view],
    queryFn: () => unwrap(api.GET('/api/v1/staff/ownership-transfers', { params: { query: { status: view } } })),
  });
  const cancel = useAction(
    (v: { transfer: Transfer; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/ownership-transfers/{id}/cancel', {
          params: { path: { id: v.transfer.id } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('cancelled'));
        setCancelling(null);
      },
    },
  );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Segmented<View>
        label={t('show')}
        value={view}
        onChange={setView}
        options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Transfer>
            rows={list.data?.data}
            rowKey={(row) => row.id}
            empty={t('none')}
            emptyHint={t('noneHint')}
            columns={[
              { key: 'ref', header: t('col.transfer'), cell: (row) => <span className="t-mono ltr">{row.reference}</span> },
              {
                key: 'unit',
                header: t('col.unit'),
                cell: (row) => (
                  <Link className="table__link" href={`/units/${row.unitId}`}>
                    <span className="ltr">{row.unitCode}</span>
                  </Link>
                ),
              },
              { key: 'buyer', header: t('col.buyer'), cell: (row) => row.buyerName ?? '—' },
              { key: 'asked', header: t('col.requested'), cell: (row) => f.dateTime(row.requestedAt) },
              {
                key: 'owed',
                header: t('col.owed'),
                cell: (row) => {
                  const owed = row.status === 'pending' ? row.owedNow : row.owedAtApproval;
                  if (owed === null) return '—';
                  return Number(owed) > 0 ? <Badge tone="terracotta">{f.money(owed)}</Badge> : <span className="t-secondary">{t('nothing')}</span>;
                },
              },
              {
                key: 'act',
                header: '',
                cell: (row) =>
                  row.status === 'pending' ? (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" variant="primary" onClick={() => setApproving(row)}>
                        {c('approve')}
                      </Button>
                      <Button size="sm" onClick={() => setCancelling(row)}>
                        {c('cancel')}
                      </Button>
                    </span>
                  ) : row.duesExceptionCode ? (
                    <span className="t-secondary">{t('exception', { reason: label(row.duesExceptionCode) })}</span>
                  ) : (
                    <span className="t-secondary">{label(row.cancelReason ?? row.status)}</span>
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
        title={t('cancelTitle')}
        description={t('cancelDescription')}
        codes={REASON_CODES.ownershipTransferCancel}
        confirmLabel={t('cancelTitle')}
        danger
        pending={cancel.isPending}
        error={cancel.error ? <ErrorText error={cancel.error} /> : undefined}
        onConfirm={(reasonCode) => cancelling && cancel.mutate({ transfer: cancelling, reasonCode })}
      />
    </>
  );
}

/**
 * Approves a transfer: at once when the unit owes nothing; else, as an
 * exception, with a reason and a fresh code (the step-up).
 */
function ApproveDialog({ transfer, onClose }: { transfer: Transfer; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
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
        toast.show(t('approved'));
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
        title={t('stepTitle')}
        description={t('stepDescription')}
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
      title={t('approveTitle', { reference: transfer.reference })}
      description={t('approveDescription', { unit: transfer.unitCode, buyer: transfer.buyerName ?? t('theNewOwner') })}
      onSubmit={() => (owes ? setStepping(true) : approve.mutate(undefined))}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="danger" loading={approve.isPending} disabled={owes && exception === ''}>
            {owes ? t('approveException') : t('approveTransfer')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={approve.error} />
        {owes ? (
          <>
            <Alert tone="warn">{t('owes', { amount: f.money(owedNow) })}</Alert>
            <Field label={t('whyAhead')}>
              {(p) => (
                <Select {...p} value={exception} onChange={(e) => setException(e.target.value)}>
                  <option value="">{t('selectReason')}</option>
                  {REASON_CODES.transferDuesException.map((code) => (
                    <option key={code} value={code}>
                      {label(code)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : (
          <p className="t-secondary">{t('owesNothing')}</p>
        )}
      </div>
    </Dialog>
  );
}
