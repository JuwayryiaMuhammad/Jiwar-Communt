'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Holiday } from '@/lib/queries';

const iso = (d: Date) => d.toISOString().slice(0, 10);

function NewHolidayDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [day, setDay] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [stopsWorks, setStopsWorks] = useState(true);
  const save = useAction(
    () => unwrap(api.POST('/api/v1/staff/holidays', { body: { day, nameEn, nameAr, stopsWorks } })),
    {
      invalidate: [keys.spacesAll, keys.permitSettings],
      onDone: () => {
        toast.show('Holiday added.');
        onClose();
      },
    },
  );
  const ready = day !== '' && nameEn.trim() !== '' && nameAr.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a holiday"
      description="One a day. Bookings and planned work that day are flagged, never moved."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Day" error={fieldError(save.error, 'day')}>
          {(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}
        </Field>
        <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} value={nameEn} maxLength={80} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" value={nameAr} maxLength={80} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <Checkbox
          label="Works and moves stop that day (a permits’ day off)"
          checked={stopsWorks}
          onChange={(e) => setStopsWorks(e.target.checked)}
        />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/**
 * The compound's holiday calendar (ADR 0084). A holiday that stops works is
 * a day off of the permits; bookings and planned work are only flagged.
 */
export default function HolidaysPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('spaces.manage');
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(new Date(Date.now() + 365 * 24 * 3_600_000)));
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: keys.holidays(from, to), queryFn: () => fetchers.holidays(from, to), enabled: allowed });
  const toggle = useAction(
    (h: Holiday) =>
      unwrap(api.PATCH('/api/v1/staff/holidays/{id}', { params: { path: { id: h.id } }, body: { stopsWorks: !h.stopsWorks } })),
    { invalidate: [keys.spacesAll, keys.permitSettings], onDone: () => toast.show('Saved.') },
  );
  const remove = useAction(
    (h: Holiday) => unwrap(api.DELETE('/api/v1/staff/holidays/{id}', { params: { path: { id: h.id } } })),
    { invalidate: [keys.spacesAll, keys.permitSettings], onDone: () => toast.show('Holiday removed.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Holidays" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Holidays"
        description="The compound’s holidays. One that stops works refuses works and moves that day; bookings and planned work are flagged."
      />
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To" hint="At most a year after From.">
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          Add a holiday
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Holiday>
            rows={list.data?.data ?? []}
            rowKey={(h) => h.id}
            empty="No holiday in this period"
            columns={[
              { key: 'day', header: 'Day', cell: (h) => <span className="t-mono">{h.day}</span> },
              { key: 'name', header: 'Name', cell: (h) => `${h.nameEn} · ${h.nameAr}` },
              {
                key: 'works',
                header: 'Works',
                cell: (h) => (h.stopsWorks ? <Badge tone="terracotta">Stop</Badge> : <Badge tone="beige">Go on</Badge>),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (h) => (
                  <>
                    <Button size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(h)}>
                      {h.stopsWorks ? 'Let works go on' : 'Stop works'}
                    </Button>
                    <Button size="sm" variant="text" loading={remove.isPending} onClick={() => remove.mutate(h)}>
                      Remove
                    </Button>
                  </>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <ErrorAlert error={toggle.error ?? remove.error} />
      {adding ? <NewHolidayDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
