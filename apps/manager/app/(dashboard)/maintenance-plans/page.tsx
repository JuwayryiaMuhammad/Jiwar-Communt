'use client';

import { fieldError, formatDate, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PlanSummary } from '@/lib/queries';

type Active = 'true' | 'false' | '';

function NewPlanDialog({ onClose }: { onClose: () => void }) {
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
        toast.show('The plan is on.');
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
      title="New maintenance plan"
      description="Planned work on an asset: its work orders open a few days before they are due, go to the asset type's technicians, and carry the checklist."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Add plan
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label="Asset" error={fieldError(save.error, 'assetId')}>
            {(p) => (
              <Select {...p} value={f.assetId} onChange={set('assetId')}>
                <option value="">Select…</option>
                {(assets.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="What is done" error={fieldError(save.error, 'title')}>
            {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
          </Field>
        </div>
        <Segmented<'calendar' | 'usage'>
          label="Comes due"
          value={f.trigger}
          onChange={(v) => setF({ ...f, trigger: v })}
          options={[
            { value: 'calendar', label: 'On the calendar' },
            { value: 'usage', label: 'By usage' },
          ]}
        />
        {f.trigger === 'calendar' ? (
          <div className="form__row">
            <Field label="Every" error={fieldError(save.error, 'every')}>
              {(p) => <Input {...p} type="number" min={1} max={365} value={f.every} onChange={set('every')} />}
            </Field>
            <Field label="Unit">
              {(p) => (
                <Select {...p} value={f.unit} onChange={set('unit')}>
                  {['day', 'week', 'month', 'year'].map((u) => (
                    <option key={u} value={u}>
                      {u}s
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="From" error={fieldError(save.error, 'anchorOn')}>
              {(p) => <Input {...p} type="date" value={f.anchorOn} onChange={set('anchorOn')} />}
            </Field>
            <Field label="Counted">
              {(p) => (
                <Select {...p} value={f.basis} onChange={set('basis')}>
                  <option value="fixed">On fixed dates</option>
                  <option value="floating">From the day it was done</option>
                </Select>
              )}
            </Field>
          </div>
        ) : (
          <div className="form__row">
            <Field label="Metric" hint="As the checklist's reading names it, e.g. run_hours." error={fieldError(save.error, 'metricKey')}>
              {(p) => <Input {...p} value={f.metricKey} onChange={set('metricKey')} />}
            </Field>
            <Field label="Every (of the metric)" error={fieldError(save.error, 'usageInterval')}>
              {(p) => <Input {...p} value={f.usageInterval} onChange={set('usageInterval')} />}
            </Field>
          </div>
        )}
        <div className="form__row">
          <Field label="Checklist" error={fieldError(save.error, 'checklistId')}>
            {(p) => (
              <Select {...p} value={f.checklistId} onChange={set('checklistId')}>
                <option value="">None</option>
                {(checklists.data?.data ?? [])
                  .filter((c) => c.active && c.purpose !== 'inspection')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nameEn}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Opens days before" error={fieldError(save.error, 'leadDays')}>
            {(p) => <Input {...p} type="number" min={0} max={60} value={f.leadDays} onChange={set('leadDays')} />}
          </Field>
          <Field label="On time within days after" error={fieldError(save.error, 'graceDays')}>
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
  const { ready, can } = usePermissions();
  const [active, setActive] = useState<Active>('true');
  const [open, setOpen] = useState(false);
  const filters = { active };
  const list = useCursorList(keys.plans(filters), (c) => fetchers.plans(filters, c), { enabled: can('assets.read') });
  if (ready && !can('assets.read'))
    return (
      <>
        <PageHeader title="Planned maintenance" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Planned maintenance"
        description="Work on the compound's assets that comes due on the calendar or by usage, opened as work orders before it is due."
        actions={
          can('assets.manage') ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>
              New plan
            </Button>
          ) : undefined
        }
      />
      <div className="toolbar">
        <Segmented<Active>
          label="Plans shown"
          value={active}
          onChange={setActive}
          options={[
            { value: 'true', label: 'On' },
            { value: 'false', label: 'Off' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<PlanSummary>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty="No plan"
            columns={[
              {
                key: 't',
                header: 'Plan',
                cell: (p) => (
                  <Link className="table__link" href={`/maintenance-plans/${p.id}`}>
                    {p.title}
                  </Link>
                ),
              },
              { key: 'k', header: 'Comes due', cell: (p) => (p.trigger === 'usage' ? 'By usage' : 'On the calendar') },
              { key: 'n', header: 'Next due', cell: (p) => (p.nextDueOn ? formatDate(p.nextDueOn) : '—') },
              { key: 'a', header: 'Status', cell: (p) => (p.active ? 'On' : <Badge tone="beige">Off</Badge>) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <NewPlanDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
