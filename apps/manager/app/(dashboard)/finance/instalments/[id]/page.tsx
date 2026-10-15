'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Stat, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { Back } from '@/components/facilities/bits';
import { InvoiceDetailDialog } from '@/components/finance/invoice-detail';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type InstalmentPlanDetail } from '@/lib/queries';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA');

function CancelPlan({ plan, onClose }: { plan: InstalmentPlanDetail; onClose: () => void }) {
  const toast = useToast();
  const [dueOn, setDueOn] = useState(inDays(14));
  const cancel = useAction(
    () => unwrap(api.POST('/api/v1/staff/instalment-plans/{id}/cancel', { params: { path: { id: plan.id } }, body: { dueOn } })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (p) => {
        toast.show(`Cancelled. ${p.remainderInvoiceNumber ?? 'A remainder invoice'} asks for what the instalments owed.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Cancel ${plan.number}?`}
      description={`What its instalments still owe (${egp(plan.outstanding)}) is credited off them and asked for again in one invoice, announced to the unit.`}
      onSubmit={() => cancel.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Keep the plan</Button>
          <Button type="submit" variant="danger" loading={cancel.isPending}>
            Cancel the plan
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="The remainder falls due" error={fieldError(cancel.error, 'dueOn')}>
          {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
        </Field>
        <ErrorAlert error={cancel.error} />
      </div>
    </Dialog>
  );
}

/** One instalment plan (ADR 0048): its instalments and where each stands. */
export default function InstalmentPlanPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const plan = useQuery({ queryKey: keys.instalmentPlan(id), queryFn: () => fetchers.instalmentPlan(id), enabled: allowed });
  const [cancelling, setCancelling] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/finance/instalments" label="Instalment plans" />} title="Instalment plan" />
        <ForbiddenState />
      </>
    );
  const p = plan.data;
  return (
    <>
      <PageHeader
        back={<Back href="/finance/instalments" label="Instalment plans" />}
        title={p ? `Plan ${p.number}` : 'Instalment plan'}
        description={p ? `Unit ${p.unitCode} · from ${p.invoiceNumber} · set up ${formatDateTime(p.createdAt)}` : undefined}
        actions={
          p && p.status === 'active' ? (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              Cancel plan
            </Button>
          ) : null
        }
      />
      <QueryState query={plan}>
        {p ? (
          <div className="stack">
            <div className="row" style={{ gap: 16 }}>
              <Stat label="Total" value={egp(p.total)} />
              <Stat label="Still owed" value={egp(p.outstanding)} />
              <Stat label="Status" value={<StatusBadge status={p.status} />} />
            </div>
            {p.remainderInvoiceId ? (
              <p>
                Cancelled {p.cancelledAt ? formatDateTime(p.cancelledAt) : ''}: the remainder is{' '}
                <Button variant="text" className="t-mono" onClick={() => setOpen(p.remainderInvoiceId)}>
                  {p.remainderInvoiceNumber}
                </Button>
                .
              </p>
            ) : null}
            <Card flush>
              <CardHeader title="Instalments" actions={<Link href={`/finance/units/${p.unitId}`}>Unit statement</Link>} />
              <DataTable<InstalmentPlanDetail['instalments'][number]>
                rows={p.instalments}
                rowKey={(i) => i.id}
                empty="No instalment"
                columns={[
                  { key: 'p', header: '#', cell: (i) => i.position },
                  {
                    key: 'n',
                    header: 'Invoice',
                    cell: (i) => (
                      <Button variant="text" className="table__link t-mono" onClick={() => setOpen(i.id)}>
                        {i.number}
                      </Button>
                    ),
                  },
                  { key: 'd', header: 'Due', cell: (i) => i.dueOn },
                  { key: 't', header: 'Amount', cell: (i) => egp(i.total) },
                  { key: 'paid', header: 'Paid', cell: (i) => egp(i.paid) },
                  { key: 'o', header: 'Owed', cell: (i) => egp(i.outstanding) },
                  { key: 's', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
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
