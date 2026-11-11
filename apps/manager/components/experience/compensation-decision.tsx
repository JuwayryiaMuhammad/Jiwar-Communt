'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, ReasonCodeDialog, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Compensation } from '@/lib/queries';
import ar from '@/messages/ar/experience-cases';
import en from '@/messages/en/experience-cases';

/** What a Field hands its input. */
interface FieldProps {
  id?: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

/**
 * The unit's invoices to put a credit note on (ADR 0082), newest first, paged:
 * a unit with many invoices loads more. Without `finance.invoice` the list
 * is closed to the account, so the id is typed as before.
 */
function InvoicePicker({ unitId, value, onChange, id, ...aria }: FieldProps & { unitId: string; value: string; onChange: (id: string) => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { can } = usePermissions();
  const mayList = can('finance.invoice');
  const list = useCursorList(keys.compensationInvoices(unitId), (cursor) => fetchers.invoices({ unitId }, cursor, 50), { enabled: mayList });
  if (!mayList) return <Input id={id} {...aria} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('decision.invoiceId')} />;
  return (
    <div className="stack stack--sm">
      <Select id={id} {...aria} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{list.isPending ? t('decision.loading') : (list.rows ?? []).length ? c('select') : t('decision.noInvoice')}</option>
        {(list.rows ?? []).map((i) => (
          <option key={i.id} value={i.id}>
            {t('decision.invoiceOption', { number: i.number, due: f.day(i.dueOn), total: f.money(i.total), status: label(i.status) })}
          </option>
        ))}
      </Select>
      <ErrorAlert error={list.error} />
      <LoadMore query={list} />
    </div>
  );
}

/**
 * What the board approved for a compensation above its limit and no credit
 * has used yet (ADR 0073), at least the compensation's amount. Without
 * `finance.invoice` the id is typed as before.
 */
function AuthorizationPicker({ amount, value, onChange, id, ...aria }: FieldProps & { amount: string | null; value: string; onChange: (id: string) => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { can } = usePermissions();
  const mayList = can('finance.invoice');
  const found = useQuery({ queryKey: keys.compensationAuthorizations, queryFn: fetchers.compensationAuthorizations, enabled: mayList });
  if (!mayList) return <Input id={id} {...aria} value={value} onChange={(e) => onChange(e.target.value)} />;
  const rows = (found.data?.data ?? []).filter((a) => amount === null || Number(a.amount) >= Number(amount));
  return (
    <div className="stack stack--sm">
      <Select id={id} {...aria} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{found.isPending ? t('decision.loading') : rows.length ? c('select') : t('decision.noAuthorization')}</option>
        {rows.map((a) => (
          <option key={a.id} value={a.id}>
            {t('decision.authorizationOption', { amount: f.money(a.amount), when: f.date(a.createdAt) })}
          </option>
        ))}
      </Select>
      <ErrorAlert error={found.error} />
    </div>
  );
}

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
              {(p) => <InvoicePicker {...p} unitId={unitId} value={invoiceId} onChange={setInvoiceId} />}
            </Field>
          ) : null}
          {board ? (
            <Field label={t('decision.authorization')} hint={<Link href="/governance">{t('decision.authorizationLink')}</Link>}>
              {(p) => <AuthorizationPicker {...p} amount={x.amount} value={authorizationId} onChange={setAuthorizationId} />}
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
