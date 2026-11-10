'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, ReasonCodeDialog, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type Compensation } from '@/lib/queries';
import ar from '@/messages/ar/experience-cases';
import en from '@/messages/en/experience-cases';

/**
 * The manager's decision on a compensation (ADR 0082), once. A credit names
 * the unit's invoice the credit note is issued on; above the board's binding
 * limit (`authority.decider` is `board`) it also names what the board
 * approved, raised as a `compensation_above_limit` request beforehand.
 */
export function CompensationDecision({ compensation: x, unitId }: { compensation: Compensation; unitId: string }) {
  const t = useT(en, ar);
  const f = useFormat();
  const toast = useToast();
  const [open, setOpen] = useState<'approve' | 'reject' | null>(null);
  const [invoiceId, setInvoiceId] = useState('');
  const [authorizationId, setAuthorizationId] = useState('');
  const refresh = { invalidate: [keys.experienceAll] };
  const path = { path: { id: x.id } };
  const approve = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/experience/compensations/{id}/decide', {
          params: path,
          body: {
            decision: 'approve',
            ...(x.kind === 'credit' ? { invoiceId } : {}),
            ...(authorizationId ? { authorizationId } : {}),
          },
        }),
      ),
    {
      ...refresh,
      onDone: () => {
        toast.show(x.kind === 'credit' ? t('decision.approvedCredit') : t('decision.approved'));
        setOpen(null);
      },
    },
  );
  const reject = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/experience/compensations/{id}/decide', { params: path, body: { decision: 'reject', reasonCode } })),
    {
      ...refresh,
      onDone: () => {
        toast.show(t('decision.rejected'));
        setOpen(null);
      },
    },
  );
  if (x.status !== 'proposed') return null;
  const board = x.authority?.decider === 'board';
  return (
    <>
      <span className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => setOpen('approve')}>
          {board ? t('decision.approveBoard') : t('decision.approve')}
        </Button>
        <Button size="sm" onClick={() => setOpen('reject')}>
          {t('decision.reject')}
        </Button>
      </span>
      <Dialog
        open={open === 'approve'}
        onClose={() => setOpen(null)}
        title={t('decision.title')}
        description={board ? t('decision.aboveLimit', { threshold: f.money(x.authority?.threshold) }) : t('decision.withinLimit')}
        onSubmit={(e) => {
          e.preventDefault();
          approve.mutate();
        }}
        footer={
          <Button type="submit" variant="primary" loading={approve.isPending}>
            {t('decision.approve')}
          </Button>
        }
      >
        <div className="stack">
          {x.kind === 'credit' ? (
            <Field label={t('decision.invoice')} hint={<Link href={`/units/${unitId}`}>{t('decision.invoiceLink')}</Link>}>
              {(p) => <Input {...p} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} placeholder={t('decision.invoiceId')} />}
            </Field>
          ) : null}
          {board ? (
            <Field label={t('decision.authorization')} hint={<Link href="/governance">{t('decision.authorizationLink')}</Link>}>
              {(p) => <Input {...p} value={authorizationId} onChange={(e) => setAuthorizationId(e.target.value)} />}
            </Field>
          ) : null}
          <ErrorAlert error={approve.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={open === 'reject'}
        onClose={() => setOpen(null)}
        title={t('decision.rejectTitle')}
        codes={REASON_CODES.compensationReject}
        confirmLabel={t('decision.reject')}
        pending={reject.isPending}
        error={<ErrorAlert error={reject.error} />}
        onConfirm={(code) => reject.mutate(code)}
      />
    </>
  );
}
