'use client';

import { fieldError, formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, Stat, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Measure } from '@/lib/queries';

const KINDS = ['electricity', 'water', 'gas', 'fuel', 'run_hours'] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function NewMeasureDialog({ onClose }: { onClose: () => void }) {
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
        toast.show('Measure added.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="New saving measure"
      description="On a building, or the whole compound when none is named. Its effect is read as the weeks before against the weeks after."
      onSubmit={() => f.title.trim() && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.title.trim()}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label="What was done" error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
        </Field>
        <div className="form__row">
          <Field label="Saves" error={fieldError(save.error, 'kind')}>
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Building" hint="Leave empty for the compound." error={fieldError(save.error, 'building')}>
            {(p) => <Input {...p} value={f.building} onChange={set('building')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label="From" error={fieldError(save.error, 'startsOn')}>
            {(p) => <Input {...p} type="date" value={f.startsOn} onChange={set('startsOn')} />}
          </Field>
          <Field label="Cost (EGP)" error={fieldError(save.error, 'cost')}>
            {(p) => <Input {...p} value={f.cost} onChange={set('cost')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function EffectDialog({ measure, onClose }: { measure: Measure; onClose: () => void }) {
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
        toast.show('Ended.');
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
      description={`${humanize(measure.kind)} from ${formatDate(measure.startsOn)}${measure.building ? ` in ${measure.building}` : ''}`}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {can('energy.manage') && !measure.endedOn ? (
            <Button loading={end.isPending} onClick={() => end.mutate()}>
              End on {formatDate(endedOn)}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={end.error} />
        <div className="form__row">
          <Field label="Weeks each side" hint="Whole weeks: both sides hold the same days of the week.">
            {(p) => <Input {...p} type="number" min={1} max={26} value={weeks} onChange={(x) => setWeeks(Number(x.target.value) || 4)} />}
          </Field>
          {can('energy.manage') && !measure.endedOn ? (
            <Field label="Ended on" error={fieldError(end.error, 'endedOn')}>
              {(p) => <Input {...p} type="date" value={endedOn} onChange={(x) => setEndedOn(x.target.value)} />}
            </Field>
          ) : null}
        </div>
        <QueryState query={card}>
          {e ? (
            <div className="grid grid--stats">
              <Stat label="Before, a day" value={e.before.perDay} hint={`${formatDate(e.before.from)} – ${formatDate(e.before.to)}`} />
              <Stat label="After, a day" value={e.after?.perDay ?? '—'} hint={e.after ? `${formatDate(e.after.from)} – ${formatDate(e.after.to)}` : 'Not started'} />
              <Stat label="Change" value={e.changePct === null ? '—' : `${e.changePct} %`} hint={e.complete ? 'Every day counted' : 'Still counting'} />
            </div>
          ) : null}
        </QueryState>
      </div>
    </Dialog>
  );
}

/** Saving measures (ADR 0066) and the effect each had, read now. */
export default function MeasuresPage() {
  const { ready, can } = usePermissions();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Measure | null>(null);
  const list = useCursorList(keys.measures, (c) => fetchers.measures(c), { enabled: can('energy.read') });
  if (ready && !can('energy.read'))
    return (
      <>
        <PageHeader title="Saving measures" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Saving measures"
        description="What was done to use less, and what it changed."
        actions={
          can('energy.manage') ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New measure
            </Button>
          ) : null
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Measure>
            rows={list.rows}
            rowKey={(m) => m.id}
            empty="No measure"
            columns={[
              {
                key: 't',
                header: 'Measure',
                cell: (m) => (
                  <Button size="sm" variant="text" onClick={() => setOpen(m)}>
                    {m.title}
                  </Button>
                ),
              },
              { key: 'k', header: 'Saves', cell: (m) => humanize(m.kind) },
              { key: 'w', header: 'Where', cell: (m) => m.building ?? (m.meterId ? 'A meter' : 'The compound') },
              { key: 's', header: 'From', cell: (m) => formatDate(m.startsOn) },
              { key: 'e', header: 'Ended', cell: (m) => (m.endedOn ? formatDate(m.endedOn) : '—') },
              { key: 'c', header: 'Cost', cell: (m) => (m.cost ? `${m.cost} EGP` : '—') },
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
