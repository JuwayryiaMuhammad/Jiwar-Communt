'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { durationText } from '@/components/club/logic';
import { validMoney } from '@/components/facilities/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ClubPlan } from '@/lib/queries';
import clubAr from '@/messages/ar/money-club';
import ar from '@/messages/ar/money-club-plans';
import clubEn from '@/messages/en/money-club';
import en from '@/messages/en/money-club-plans';

type Kind = ClubPlan['durationKind'];

/** The plan's name in the page's language. */
function usePlanName() {
  const { locale } = useLocale();
  return (p: { nameEn: string; nameAr: string }) => (locale === 'ar' ? p.nameAr : p.nameEn);
}

function PlanDialog({ plan, onClose }: { plan: ClubPlan | null; onClose: () => void }) {
  const t = useT(en, ar);
  const tc = useT(clubEn, clubAr);
  const c = useCommonT();
  const name = usePlanName();
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
        toast.show(t('saved', { name: name(p) }));
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
      title={plan ? t('editTitle', { name: name(plan) }) : t('newPlan')}
      description={t('dialogDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} dir="ltr" lang="en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} maxLength={80} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        {plan ? null : (
          <Field label={t('duration')} hint={t('durationHint')}>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="monthly">{tc('duration.monthly')}</option>
                <option value="quarterly">{tc('duration.quarterly')}</option>
                <option value="annual">{tc('duration.annual')}</option>
                <option value="custom">{t('option.custom')}</option>
              </Select>
            )}
          </Field>
        )}
        {!plan && kind === 'custom' ? (
          <Field label={t('days')} error={fieldError(save.error, 'durationDays') ?? (daysOk ? undefined : t('daysRange'))}>
            {(p) => <Input {...p} type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
        ) : null}
        <Field label={t('price')} error={fieldError(save.error, 'price') ?? (price && !validMoney(price) ? t('moneyInvalid') : undefined)}>
          {(p) => <Input {...p} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The club's plans (ADR 0044): the manager sets them; the accountant reads them. */
export default function ClubPlansPage() {
  const t = useT(en, ar);
  const tc = useT(clubEn, clubAr);
  const c = useCommonT();
  const fmt = useFormat();
  const { locale } = useLocale();
  const name = usePlanName();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const canManage = can('facilities.manage');
  const allowed = canManage || can('club.billing');
  const plans = useQuery({ queryKey: keys.clubPlans, queryFn: fetchers.clubPlans, enabled: allowed });
  const [open, setOpen] = useState<{ plan: ClubPlan | null } | null>(null);
  const setActive = useAction(
    (p: ClubPlan) => unwrap(api.PATCH('/api/v1/staff/club-plans/{id}', { params: { path: { id: p.id } }, body: { active: !p.active } })),
    {
      invalidate: [keys.clubPlans],
      onDone: (p) => toast.show(p.active ? t('offeredAgain', { name: name(p) }) : t('retiredToast', { name: name(p) })),
    },
  );
  if (ready && !allowed) return <ForbiddenState />;
  // The name in the other language, beside the page's.
  const other = locale === 'ar' ? 'en' : 'ar';

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {canManage ? (
        <div className="toolbar">
          <span className="spacer" />
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ plan: null })}>
            {t('newPlan')}
          </Button>
        </div>
      ) : null}
      <ErrorAlert error={setActive.error} />
      <Card flush>
        <QueryState query={plans}>
          <DataTable<ClubPlan>
            rows={plans.data?.data}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              {
                key: 'name',
                header: t('col.plan'),
                cell: (p) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{name(p)}</span>
                    <span className="t-secondary" dir={other === 'ar' ? 'rtl' : 'ltr'} lang={other}>
                      {other === 'ar' ? p.nameAr : p.nameEn}
                    </span>
                    {!p.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'duration', header: t('col.duration'), cell: (p) => durationText(p, tc) },
              { key: 'price', header: t('col.price'), cell: (p) => fmt.money(p.price) },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (p) =>
                  canManage ? (
                    <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <Button size="sm" onClick={() => setOpen({ plan: p })}>
                        {c('edit')}
                      </Button>
                      <Button size="sm" loading={setActive.isPending && setActive.variables?.id === p.id} onClick={() => setActive.mutate(p)}>
                        {p.active ? t('retire') : t('restore')}
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
