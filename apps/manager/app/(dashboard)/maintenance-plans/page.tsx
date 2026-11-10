'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { nameOf } from '@/components/assets/format';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PlanSummary } from '@/lib/queries';
import ar from '@/messages/ar/assets-plans';
import en from '@/messages/en/assets-plans';

type Active = 'true' | 'false' | '';
const VIEWS = ['true', 'false', 'all'] as const;
const TRIGGERS = ['calendar', 'usage'] as const;
const UNITS = ['day', 'week', 'month', 'year'] as const;

function NewPlanDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const router = useRouter();
  const assets = useQuery({ queryKey: keys.assets({ status: 'in_service' }), queryFn: () => fetchers.assets({ status: 'in_service' }, undefined, 100) });
  const checklists = useQuery({ queryKey: keys.checklists, queryFn: fetchers.checklists });
  const [f, setF] = useState({
    assetId: '',
    title: '',
    trigger: 'calendar' as 'calendar' | 'usage',
    every: '3',
    unit: 'month' as 'day' | 'week' | 'month' | 'year',
    anchorOn: '',
    basis: 'fixed' as 'fixed' | 'floating',
    metricKey: '',
    usageInterval: '',
    checklistId: '',
    leadDays: '7',
    graceDays: '3',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/plans', {
          body: {
            assetId: f.assetId,
            title: f.title.trim(),
            trigger: f.trigger,
            ...(f.trigger === 'calendar'
              ? { every: Number(f.every), unit: f.unit, anchorOn: f.anchorOn, basis: f.basis }
              : { metricKey: f.metricKey.trim(), usageInterval: f.usageInterval.trim() }),
            ...(f.checklistId ? { checklistId: f.checklistId } : {}),
            leadDays: Number(f.leadDays),
            graceDays: Number(f.graceDays),
            // The compound's own work orders start normal; dispatch reprioritizes.
            priority: 'normal',
          },
        }),
      ),
    {
      invalidate: [keys.plansAll],
      onDone: (p) => {
        toast.show(t('planOn'));
        router.push(`/maintenance-plans/${p.id}`);
      },
    },
  );
  const ready =
    f.assetId !== '' &&
    f.title.trim() !== '' &&
    (f.trigger === 'calendar' ? f.anchorOn !== '' && f.every !== '' : f.metricKey.trim() !== '' && f.usageInterval.trim() !== '');
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('addPlan')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label={t('asset')} error={fieldError(save.error, 'assetId')}>
            {(p) => (
              <Select {...p} value={f.assetId} onChange={set('assetId')}>
                <option value="">{c('select')}</option>
                {(assets.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {nameOf(fmt.locale, a)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('whatIsDone')} error={fieldError(save.error, 'title')}>
            {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
          </Field>
        </div>
        <Segmented<'calendar' | 'usage'>
          label={t('comesDue')}
          value={f.trigger}
          onChange={(v) => setF({ ...f, trigger: v })}
          options={TRIGGERS.map((v) => ({ value: v, label: t(`trigger.${v}`) }))}
        />
        {f.trigger === 'calendar' ? (
          <div className="form__row">
            <Field label={t('every')} error={fieldError(save.error, 'every')}>
              {(p) => <Input {...p} type="number" min={1} max={365} value={f.every} onChange={set('every')} />}
            </Field>
            <Field label={t('unit')}>
              {(p) => (
                <Select {...p} value={f.unit} onChange={set('unit')}>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {t(`unit.${u}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('from')} error={fieldError(save.error, 'anchorOn')}>
              {(p) => <Input {...p} type="date" value={f.anchorOn} onChange={set('anchorOn')} />}
            </Field>
            <Field label={t('counted')}>
              {(p) => (
                <Select {...p} value={f.basis} onChange={set('basis')}>
                  <option value="fixed">{t('basis.fixed')}</option>
                  <option value="floating">{t('basis.floating')}</option>
                </Select>
              )}
            </Field>
          </div>
        ) : (
          <div className="form__row">
            <Field label={t('metric')} hint={t('metricHint')} error={fieldError(save.error, 'metricKey')}>
              {(p) => <Input {...p} dir="ltr" value={f.metricKey} onChange={set('metricKey')} />}
            </Field>
            <Field label={t('usageEvery')} error={fieldError(save.error, 'usageInterval')}>
              {(p) => <Input {...p} dir="ltr" value={f.usageInterval} onChange={set('usageInterval')} />}
            </Field>
          </div>
        )}
        <div className="form__row">
          <Field label={t('checklist')} error={fieldError(save.error, 'checklistId')}>
            {(p) => (
              <Select {...p} value={f.checklistId} onChange={set('checklistId')}>
                <option value="">{t('none')}</option>
                {(checklists.data?.data ?? [])
                  .filter((x) => x.active && x.purpose !== 'inspection')
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {nameOf(fmt.locale, x)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={t('leadDays')} error={fieldError(save.error, 'leadDays')}>
            {(p) => <Input {...p} type="number" min={0} max={60} value={f.leadDays} onChange={set('leadDays')} />}
          </Field>
          <Field label={t('graceDays')} error={fieldError(save.error, 'graceDays')}>
            {(p) => <Input {...p} type="number" min={0} max={60} value={f.graceDays} onChange={set('graceDays')} />}
          </Field>
        </div>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** Assets' planned work (ADR 0064). */
export default function PlansPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const [active, setActive] = useState<Active>('true');
  const [open, setOpen] = useState(false);
  const filters = { active };
  const list = useCursorList(keys.plans(filters), (c) => fetchers.plans(filters, c), { enabled: can('assets.read') });
  if (ready && !can('assets.read'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can('assets.manage') ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
              {t('newPlan')}
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<Active>
          label={t('shown')}
          value={active}
          onChange={setActive}
          options={VIEWS.map((v) => ({ value: v === 'all' ? '' : v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PlanSummary>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('noPlan')}
            columns={[
              {
                key: 't',
                header: t('col.plan'),
                cell: (p) => (
                  <Link className="table__link" href={`/maintenance-plans/${p.id}`}>
                    {p.title}
                  </Link>
                ),
              },
              { key: 'k', header: t('col.trigger'), cell: (p) => (p.trigger === 'usage' ? t('trigger.usage') : t('trigger.calendar')) },
              { key: 'n', header: t('col.nextDue'), cell: (p) => (p.nextDueOn ? fmt.day(p.nextDueOn) : '—') },
              { key: 'a', header: t('col.status'), cell: (p) => (p.active ? t('on') : <Badge tone="beige">{t('off')}</Badge>) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <NewPlanDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
