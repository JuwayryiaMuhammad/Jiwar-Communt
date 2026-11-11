'use client';

import { ApiError, fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Select, Textarea, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PurchaseOrder } from '@/lib/queries';
import ar from '@/messages/ar/po-order';
import en from '@/messages/en/po-order';
import { LinesEditor } from './lines-editor';
import { BudgetLineSelect, useStockChoices } from './pickers';
import { linesBody, linesFromOrder, linesReady, type FormLine } from './po';

const today = () => new Date().toLocaleDateString('en-CA');
const ASKS_FOR_BOARD = ['PURCHASE_ORDER_NEEDS_APPROVAL', 'PURCHASE_ORDER_APPROVAL_INVALID'];

/**
 * Approving an order or its waiting revision. Within the manager’s limit it
 * is a click; above it the API answers PURCHASE_ORDER_NEEDS_APPROVAL with the
 * limit and the dialog then asks for the board’s approved major contract.
 */
export function ApproveDialog({ order, revision, onClose }: { order: PurchaseOrder; revision: number | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const { can } = usePermissions();
  const [note, setNote] = useState('');
  const [approvalId, setApprovalId] = useState('');
  const first = order.status === 'requested';
  const approve = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/purchase-orders/{id}/approve', {
          params: { path: { id: order.id } },
          body: { ...(approvalId ? { approvalRequestId: approvalId } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.purchaseOrdersAll, keys.budgetsAll, keys.purchasesAll],
      onDone: () => {
        toast.show(first ? t('approved', { reference: order.reference }) : t('approvedRevision', { n: f.number(revision ?? order.revision), reference: order.reference }));
        onClose();
      },
    },
  );
  const asks = approve.error instanceof ApiError && ASKS_FOR_BOARD.includes(approve.error.code);
  const threshold = approve.error instanceof ApiError && approve.error.params.threshold ? String(approve.error.params.threshold) : null;
  const approvals = useQuery({
    queryKey: keys.majorContractApprovals,
    queryFn: () => fetchers.majorContractApprovals(),
    enabled: asks && can('governance.approvals'),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={first ? t('approveTitle', { reference: order.reference }) : t('approveRevisionTitle', { n: f.number(revision ?? order.revision), reference: order.reference })}
      description={t('approveHint')}
      onSubmit={() => approve.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={approve.isPending} disabled={asks && approvalId === ''}>
            {first ? t('approve') : t('approveRevision', { n: f.number(revision ?? order.revision) })}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('approveNote')} error={fieldError(approve.error, 'note')}>
          {(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {asks ? (
          can('governance.approvals') ? (
            <Field
              label={t('boardApproval')}
              hint={threshold ? t('boardApprovalHint', { threshold: f.money(threshold) }) : undefined}
              error={fieldError(approve.error, 'approvalRequestId')}
            >
              {(p) => (
                <Select {...p} value={approvalId} onChange={(e) => setApprovalId(e.target.value)}>
                  <option value="">{t('boardApprovalNone')}</option>
                  {(approvals.data?.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {`${a.reference} · ${f.money(a.cost)}`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <p className="hint">{t('boardApprovalNoAccess')}</p>
          )
        ) : null}
        <ErrorAlert error={approve.error} />
      </div>
    </Dialog>
  );
}

/**
 * Asking for an amendment: the whole order as it should be, prefilled from
 * the order in force, with the reason. A line that carries its id changes, a
 * new one is added and a removed one is dropped; the order stays as it is
 * until someone else approves the revision.
 */
export function AmendDialog({ order, onClose }: { order: PurchaseOrder; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { items, allowed: stockAllowed } = useStockChoices();
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [deliveryOn, setDeliveryOn] = useState(order.deliveryOn);
  const [budgetLineId, setBudgetLineId] = useState(order.budgetLineId);
  const [lines, setLines] = useState<FormLine[]>(() => linesFromOrder(order.lines));
  const amend = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/purchase-orders/{id}/amend', {
          params: { path: { id: order.id } },
          body: {
            reasonCode,
            ...(budgetLineId && budgetLineId !== order.budgetLineId ? { budgetLineId } : {}),
            ...(deliveryOn !== order.deliveryOn ? { deliveryOn } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
            lines: linesBody(lines),
          },
        }),
      ),
    {
      invalidate: [keys.purchaseOrdersAll],
      onDone: (o) => {
        toast.show(t('amended', { n: f.number(o.pendingRevision ?? o.revision + 1) }));
        onClose();
      },
    },
  );
  const err = (field: string) => fieldError(amend.error, field);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('amendTitle', { reference: order.reference })}
      description={t('amendHint')}
      onSubmit={() => amend.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={amend.isPending} disabled={reasonCode === '' || !linesReady(lines)}>
            {t('amendConfirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label={t('amendReason')} error={err('reasonCode')}>
            {(p) => (
              <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                <option value="">{c('select')}</option>
                {REASON_CODES.purchaseOrderAmend.map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('amendDelivery')} error={err('deliveryOn')}>
            {(p) => <Input {...p} type="date" min={today()} value={deliveryOn} onChange={(e) => setDeliveryOn(e.target.value)} />}
          </Field>
        </div>
        <BudgetLineSelect value={budgetLineId} onChange={setBudgetLineId} error={err('budgetLineId')} />
        <Field label={t('amendNote')} error={err('note')}>
          {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <LinesEditor lines={lines} onChange={setLines} items={items} stockAllowed={stockAllowed} error={amend.error} />
        <ErrorAlert error={amend.error} />
      </div>
    </Dialog>
  );
}
