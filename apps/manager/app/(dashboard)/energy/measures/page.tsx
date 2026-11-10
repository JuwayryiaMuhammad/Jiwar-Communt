'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, Stat, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Measure } from '@/lib/queries';
import ar from '@/messages/ar/energy-measures';
import en from '@/messages/en/energy-measures';

const KINDS = ['electricity', 'water', 'gas', 'fuel', 'run_hours'] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function NewMeasureDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [f, setF] = useState({ title: '', kind: 'electricity' as (typeof KINDS)[number], building: '', startsOn: iso(new Date()), cost: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/energy/measures', {
          body: {
            title: f.title.trim(),
            kind: f.kind,
            ...(f.building.trim() ? { building: f.building.trim() } : {}),
            startsOn: f.startsOn,
            ...(f.cost ? { cost: f.cost } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.measures],
      onDone: () => {
        toast.show(t('added'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => f.title.trim() && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.title.trim()}>
            {c('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label={t('whatWasDone')} error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
        </Field>
        <div className="form__row">
          <Field label={t('saves')} error={fieldError(save.error, 'kind')}>
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('building')} hint={t('buildingHint')} error={fieldError(save.error, 'building')}>
            {(p) => <Input {...p} value={f.building} onChange={set('building')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label={t('from')} error={fieldError(save.error, 'startsOn')}>
            {(p) => <Input {...p} type="date" value={f.startsOn} onChange={set('startsOn')} />}
          </Field>
          <Field label={t('costEgp')} error={fieldError(save.error, 'cost')}>
            {(p) => <Input {...p} value={f.cost} onChange={set('cost')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function EffectDialog({ measure, onClose }: { measure: Measure; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const fmt = useFormat();
  const toast = useToast();
  const { can } = usePermissions();
  const [weeks, setWeeks] = useState(4);
  const [endedOn, setEndedOn] = useState(iso(new Date()));
  const card = useQuery({ queryKey: keys.measure(measure.id, weeks), queryFn: () => fetchers.measure(measure.id, weeks) });
  const end = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/energy/measures/{id}/end', { params: { path: { id: measure.id } }, body: { endedOn } })),
    {
      invalidate: [keys.measures],
      onDone: () => {
        toast.show(t('ended'));
        onClose();
      },
    },
  );
  const e = card.data?.effect;
  return (
    <Dialog
      open
      onClose={onClose}
      title={measure.title}
      description={
        measure.building
          ? t('measureDescriptionIn', { kind: label(measure.kind), date: fmt.day(measure.startsOn), building: measure.building })
          : t('measureDescription', { kind: label(measure.kind), date: fmt.day(measure.startsOn) })
      }
      footer={
        <>
          <Button onClick={onClose}>{c('close')}</Button>
          {can('energy.manage') && !measure.endedOn ? (
            <Button loading={end.isPending} onClick={() => end.mutate()}>
              {t('endOn', { date: fmt.day(endedOn) })}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={end.error} />
        <div className="form__row">
          <Field label={t('weeks')} hint={t('weeksHint')}>
            {(p) => <Input {...p} type="number" min={1} max={26} value={weeks} onChange={(x) => setWeeks(Number(x.target.value) || 4)} />}
          </Field>
          {can('energy.manage') && !measure.endedOn ? (
            <Field label={t('endedOn')} error={fieldError(end.error, 'endedOn')}>
              {(p) => <Input {...p} type="date" value={endedOn} onChange={(x) => setEndedOn(x.target.value)} />}
            </Field>
          ) : null}
        </div>
        <QueryState query={card}>
          {e ? (
            <div className="grid grid--stats">
              <Stat label={t('beforeADay')} value={e.before.perDay} hint={`${fmt.day(e.before.from)} – ${fmt.day(e.before.to)}`} />
              <Stat
                label={t('afterADay')}
                value={e.after?.perDay ?? '—'}
                hint={e.after ? `${fmt.day(e.after.from)} – ${fmt.day(e.after.to)}` : t('notStarted')}
              />
              <Stat label={t('change')} value={e.changePct === null ? '—' : `${e.changePct} %`} hint={e.complete ? t('everyDay') : t('stillCounting')} />
            </div>
          ) : null}
        </QueryState>
      </div>
    </Dialog>
  );
}

/** Saving measures (ADR 0066) and the effect each had, read now. */
export default function MeasuresPage() {
  const t = useT(en, ar);
  const label = useLabel();
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Measure | null>(null);
  const list = useCursorList(keys.measures, (c) => fetchers.measures(c), { enabled: can('energy.read') });
  if (ready && !can('energy.read'))
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
          can('energy.manage') ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('newMeasure')}
            </Button>
          ) : null
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Measure>
            rows={list.rows}
            rowKey={(m) => m.id}
            empty={t('empty')}
            columns={[
              {
                key: 't',
                header: t('col.measure'),
                cell: (m) => (
                  <Button size="sm" variant="text" onClick={() => setOpen(m)}>
                    {m.title}
                  </Button>
                ),
              },
              { key: 'k', header: t('col.saves'), cell: (m) => label(m.kind) },
              { key: 'w', header: t('col.where'), cell: (m) => m.building ?? (m.meterId ? t('aMeter') : t('theCompound')) },
              { key: 's', header: t('col.from'), cell: (m) => fmt.day(m.startsOn) },
              { key: 'e', header: t('col.ended'), cell: (m) => (m.endedOn ? fmt.day(m.endedOn) : '—') },
              { key: 'c', header: t('col.cost'), cell: (m) => (m.cost ? fmt.money(m.cost) : '—') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewMeasureDialog onClose={() => setCreating(false)} /> : null}
      {open ? <EffectDialog measure={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
