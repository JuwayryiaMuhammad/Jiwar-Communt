'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { durationText, egp } from '@/components/club/logic';
import { validMoney } from '@/components/facilities/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ClubPlan } from '@/lib/queries';

type Kind = ClubPlan['durationKind'];

function PlanDialog({ plan, onClose }: { plan: ClubPlan | null; onClose: () => void }) {
  const toast = useToast();
  const [nameEn, setNameEn] = useState(plan?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(plan?.nameAr ?? '');
  const [kind, setKind] = useState<Kind>(plan?.durationKind ?? 'monthly');
  const [days, setDays] = useState(String(plan?.durationDays ?? 30));
  const [price, setPrice] = useState(plan?.price ?? '');
  const save = useAction(
    () =>
      plan
        ? unwrap(
            api.PATCH('/api/v1/staff/club-plans/{id}', {
              params: { path: { id: plan.id } },
              body: { nameEn: nameEn.trim(), nameAr: nameAr.trim(), price: price.trim() },
            }),
          )
        : unwrap(
            api.POST('/api/v1/staff/club-plans', {
              body: {
                nameEn: nameEn.trim(),
                nameAr: nameAr.trim(),
                durationKind: kind,
                ...(kind === 'custom' ? { durationDays: Number(days) } : {}),
                price: price.trim(),
              },
            }),
          ),
    {
      invalidate: [keys.clubPlans],
      onDone: (p) => {
        toast.show(`${p.nameEn} is saved.`);
        onClose();
      },
    },
  );
  const daysOk = kind !== 'custom' || (/^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 730);
  const ready = nameEn.trim() !== '' && nameAr.trim() !== '' && validMoney(price) && daysOk;

  return (
    <Dialog
      open
      onClose={onClose}
      title={plan ? `Edit ${plan.nameEn}` : 'New plan'}
      description="A plan says how long a payment keeps a membership active. Its price is shown; the amount paid is what the accountant records."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name in English" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name in Arabic" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} maxLength={80} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        {plan ? null : (
          <Field label="Duration" hint="Never changes once created.">
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="custom">A number of days</option>
              </Select>
            )}
          </Field>
        )}
        {!plan && kind === 'custom' ? (
          <Field label="Days" error={fieldError(save.error, 'durationDays') ?? (daysOk ? undefined : 'From 1 to 730.')}>
            {(p) => <Input {...p} type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
        ) : null}
        <Field label="Price, EGP" error={fieldError(save.error, 'price') ?? (price && !validMoney(price) ? 'Up to two decimals, more than zero.' : undefined)}>
          {(p) => <Input {...p} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The club's plans (ADR 0044): the manager sets them; the accountant reads them. */
export default function ClubPlansPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const canManage = can('facilities.manage');
  const allowed = canManage || can('club.billing');
  const plans = useQuery({ queryKey: keys.clubPlans, queryFn: fetchers.clubPlans, enabled: allowed });
  const [open, setOpen] = useState<{ plan: ClubPlan | null } | null>(null);
  const setActive = useAction(
    (p: ClubPlan) => unwrap(api.PATCH('/api/v1/staff/club-plans/{id}', { params: { path: { id: p.id } }, body: { active: !p.active } })),
    { invalidate: [keys.clubPlans], onDone: (p) => toast.show(p.active ? `${p.nameEn} is offered again.` : `${p.nameEn} is retired.`) },
  );
  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title="Club plans" description="What a payment at the office buys: a period of the plan. Residents see the active plans and their prices." />
      {canManage ? (
        <div className="toolbar">
          <span className="spacer" />
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ plan: null })}>
            New plan
          </Button>
        </div>
      ) : null}
      <ErrorAlert error={setActive.error} />
      <Card flush>
        <QueryState query={plans}>
          <DataTable<ClubPlan>
            rows={plans.data?.data}
            rowKey={(p) => p.id}
            empty="No plan yet"
            columns={[
              {
                key: 'name',
                header: 'Plan',
                cell: (p) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{p.nameEn}</span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {p.nameAr}
                    </span>
                    {!p.active ? <Badge tone="beige">Retired</Badge> : null}
                  </span>
                ),
              },
              { key: 'duration', header: 'Duration', cell: (p) => durationText(p) },
              { key: 'price', header: 'Price', cell: (p) => egp(p.price) },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (p) =>
                  canManage ? (
                    <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <Button size="sm" onClick={() => setOpen({ plan: p })}>
                        Edit
                      </Button>
                      <Button size="sm" loading={setActive.isPending && setActive.variables?.id === p.id} onClick={() => setActive.mutate(p)}>
                        {p.active ? 'Retire' : 'Restore'}
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {open ? <PlanDialog key={open.plan?.id ?? 'new'} plan={open.plan} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
