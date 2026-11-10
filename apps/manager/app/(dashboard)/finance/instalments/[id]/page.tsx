'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Stat, StatusBadge, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { InvoiceDetailDialog } from '@/components/finance/invoice-detail';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type InstalmentPlanDetail } from '@/lib/queries';
import ar from '@/messages/ar/fin-instalments';
import en from '@/messages/en/fin-instalments';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA');

function CancelPlan({ plan, onClose }: { plan: InstalmentPlanDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const toast = useToast();
  const [dueOn, setDueOn] = useState(inDays(14));
  const cancel = useAction(
    () => unwrap(api.POST('/api/v1/staff/instalment-plans/{id}/cancel', { params: { path: { id: plan.id } }, body: { dueOn } })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (p) => {
        toast.show(p.remainderInvoiceNumber ? t('cancelled', { invoice: p.remainderInvoiceNumber }) : t('cancelledNoNumber'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('cancelTitle', { number: plan.number })}
      description={t('cancelDescription', { amount: fmt.money(plan.outstanding) })}
      onSubmit={() => cancel.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{t('keep')}</Button>
          <Button type="submit" variant="danger" loading={cancel.isPending}>
            {t('cancelConfirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('remainderDue')} error={fieldError(cancel.error, 'dueOn')}>
          {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={cancel.error} />
      </div>
    </Dialog>
  );
}

/** One instalment plan (ADR 0048): its instalments and where each stands. */
export default function InstalmentPlanPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const plan = useQuery({ queryKey: keys.instalmentPlan(id), queryFn: () => fetchers.instalmentPlan(id), enabled: allowed });
  const [cancelling, setCancelling] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/finance/instalments" label={t('title')} />} title={t('plan')} />
        <ForbiddenState />
      </>
    );
  const p = plan.data;
  return (
    <>
      <PageHeader
        back={<Back href="/finance/instalments" label={t('title')} />}
        title={p ? t('planTitle', { number: p.number }) : t('plan')}
        description={p ? t('planDescription', { unit: p.unitCode, invoice: p.invoiceNumber, when: fmt.dateTime(p.createdAt) }) : undefined}
        actions={
          p && p.status === 'active' ? (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              {t('cancelPlan')}
            </Button>
          ) : null
        }
      />
      <QueryState query={plan}>
        {p ? (
          <div className="stack">
            <div className="row" style={{ gap: 16 }}>
              <Stat label={c('total')} value={fmt.money(p.total)} />
              <Stat label={t('stillOwed')} value={fmt.money(p.outstanding)} />
              <Stat label={c('status')} value={<StatusBadge status={p.status} />} />
            </div>
            {p.remainderInvoiceId ? (
              <p>
                {t('cancelledRemainder', { when: fmt.dateTime(p.cancelledAt) })}{' '}
                <Button variant="text" className="t-mono" onClick={() => setOpen(p.remainderInvoiceId)}>
                  {p.remainderInvoiceNumber}
                </Button>
              </p>
            ) : null}
            <Card flush>
              <CardHeader title={t('instalments')} actions={<Link href={`/finance/units/${p.unitId}`}>{t('statement')}</Link>} />
              <DataTable<InstalmentPlanDetail['instalments'][number]>
                rows={p.instalments}
                rowKey={(i) => i.id}
                empty={t('noInstalment')}
                columns={[
                  { key: 'p', header: '#', cell: (i) => fmt.number(i.position) },
                  {
                    key: 'n',
                    header: t('col.invoice'),
                    cell: (i) => (
                      <Button variant="text" className="table__link t-mono" onClick={() => setOpen(i.id)}>
                        {i.number}
                      </Button>
                    ),
                  },
                  { key: 'd', header: t('col.due'), cell: (i) => fmt.day(i.dueOn) },
                  { key: 't', header: c('amount'), cell: (i) => fmt.money(i.total) },
                  { key: 'paid', header: t('col.paid'), cell: (i) => fmt.money(i.paid) },
                  { key: 'o', header: t('col.owed'), cell: (i) => fmt.money(i.outstanding) },
                  { key: 's', header: c('status'), cell: (i) => <StatusBadge status={i.status} /> },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </QueryState>
      {cancelling && p ? <CancelPlan plan={p} onClose={() => setCancelling(false)} /> : null}
      {open ? <InvoiceDetailDialog id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
