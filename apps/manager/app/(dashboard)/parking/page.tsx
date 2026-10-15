'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { inRange } from '@/components/facilities/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ParkingSlot, type VisitorArea } from '@/lib/queries';

type Tab = 'slots' | 'areas' | 'settings';
const SETTING_RANGES = {
  maxVehiclesPerUnit: { min: 1, max: 20 },
  visitorParkingMaxHours: { min: 1, max: 24 },
  maxActiveVisitorParkingBookings: { min: 1, max: 20 },
} as const;
type SettingField = keyof typeof SETTING_RANGES;
const SETTING_TEXT: Record<SettingField, { label: string; hint: string }> = {
  maxVehiclesPerUnit: { label: 'Vehicles per unit', hint: 'Pending or active, 1 to 20.' },
  visitorParkingMaxHours: { label: 'Longest visitor booking (hours)', hint: '1 to 24.' },
  maxActiveVisitorParkingBookings: { label: 'Visitor bookings a unit holds at once', hint: 'Not yet ended, 1 to 20.' },
};

function SlotDialog({ slot, onClose }: { slot: ParkingSlot | null; onClose: () => void }) {
  const toast = useToast();
  const [unitCode, setUnitCode] = useState(slot?.unitCode ?? '');
  const [code, setCode] = useState(slot?.code ?? '');
  const [place, setPlace] = useState(slot?.place ?? '');
  const save = useAction(
    () =>
      slot
        ? unwrap(api.PATCH('/api/v1/staff/parking-slots/{id}', { params: { path: { id: slot.id } }, body: { code: code.trim(), place: place.trim() } }))
        : unwrap(api.POST('/api/v1/staff/parking-slots', { body: { unitCode: unitCode.trim(), code: code.trim(), place: place.trim() } })),
    {
      invalidate: [keys.parkingSlotsAll],
      onDone: () => {
        toast.show(slot ? 'Slot saved.' : 'Slot given to the unit.');
        onClose();
      },
    },
  );
  const ready = (slot || unitCode.trim()) && code.trim() && place.trim();
  return (
    <Dialog
      open
      onClose={onClose}
      title={slot ? `Slot ${slot.code} · unit ${slot.unitCode}` : 'Give a unit a slot'}
      description="Its people see the code and the place in the app."
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
        {slot ? null : (
          <Field label="Unit code" error={fieldError(save.error, 'unitCode')}>
            {(p) => <Input {...p} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
          </Field>
        )}
        <Field label="Slot code" hint="Once in the compound." error={fieldError(save.error, 'code')}>
          {(p) => <Input {...p} maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field label="Place" hint="e.g. Basement 2, row C." error={fieldError(save.error, 'place')}>
          {(p) => <Input {...p} maxLength={80} value={place} onChange={(e) => setPlace(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Slots() {
  const toast = useToast();
  const [unitCode, setUnitCode] = useState('');
  const [editing, setEditing] = useState<ParkingSlot | 'new' | null>(null);
  const list = useCursorList(keys.parkingSlots(unitCode.trim()), (c) => fetchers.parkingSlots(unitCode.trim(), c));
  const remove = useAction(
    (id: string) => unwrap(api.DELETE('/api/v1/staff/parking-slots/{id}', { params: { path: { id } } })),
    { invalidate: [keys.parkingSlotsAll], onDone: () => toast.show('Slot taken away.') },
  );
  return (
    <Card flush>
      <CardHeader
        title="The units’ slots"
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            Give a slot
          </Button>
        }
      />
      <CardBody>
        <Field label="Unit code">
          {(p) => <Input {...p} placeholder="Every unit" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </CardBody>
      <QueryState query={list}>
        <DataTable<ParkingSlot>
          rows={list.rows}
          rowKey={(s) => s.id}
          empty="No slot given yet"
          columns={[
            { key: 'unit', header: 'Unit', cell: (s) => <span className="t-mono">{s.unitCode}</span> },
            { key: 'code', header: 'Slot', cell: (s) => <span className="t-mono">{s.code}</span> },
            { key: 'place', header: 'Place', cell: (s) => s.place },
            {
              key: 'actions',
              header: '',
              className: 'table__actions',
              cell: (s) => (
                <span className="row" style={{ gap: 6 }}>
                  <Button size="sm" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" loading={remove.isPending && remove.variables === s.id} onClick={() => remove.mutate(s.id)}>
                    Take away
                  </Button>
                </span>
              ),
            },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
      <ErrorAlert error={remove.error} />
      {editing ? <SlotDialog slot={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function AreaDialog({ area, onClose }: { area: VisitorArea | null; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(area?.name ?? '');
  const [capacity, setCapacity] = useState(String(area?.capacity ?? 5));
  const save = useAction(
    () =>
      area
        ? unwrap(
            api.PATCH('/api/v1/staff/visitor-parking-areas/{id}', {
              params: { path: { id: area.id } },
              body: { name: name.trim(), capacity: Number(capacity) },
            }),
          )
        : unwrap(api.POST('/api/v1/staff/visitor-parking-areas', { body: { name: name.trim(), capacity: Number(capacity) } })),
    {
      invalidate: [keys.visitorAreas],
      onDone: () => {
        toast.show('Area saved.');
        onClose();
      },
    },
  );
  const okCapacity = inRange({ min: 1, max: 500 }, capacity);
  const ready = name.trim() !== '' && okCapacity;
  return (
    <Dialog
      open
      onClose={onClose}
      title={area ? `Area ${area.name}` : 'New visitor area'}
      description="Residents book a space here for a visitor. A smaller capacity leaves what is booked."
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
        <Field label="Name" hint="Once in the compound." error={fieldError(save.error, 'name')}>
          {(p) => <Input {...p} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Spaces" hint="1 to 500." error={fieldError(save.error, 'capacity') ?? (capacity && !okCapacity ? '1 to 500.' : undefined)}>
          {(p) => <Input {...p} type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Areas() {
  const toast = useToast();
  const areas = useQuery({ queryKey: keys.visitorAreas, queryFn: fetchers.visitorAreas });
  const [editing, setEditing] = useState<VisitorArea | 'new' | null>(null);
  const toggle = useAction(
    (a: VisitorArea) =>
      unwrap(api.PATCH('/api/v1/staff/visitor-parking-areas/{id}', { params: { path: { id: a.id } }, body: { active: !a.active } })),
    { invalidate: [keys.visitorAreas], onDone: (a) => toast.show(a.active ? 'Area open again.' : 'Area retired: no new booking.') },
  );
  return (
    <Card flush>
      <CardHeader
        title="Visitor areas"
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            New area
          </Button>
        }
      />
      <QueryState query={areas}>
        <DataTable<VisitorArea>
          rows={areas.data?.data}
          rowKey={(a) => a.id}
          empty="No visitor area yet"
          columns={[
            { key: 'name', header: 'Area', cell: (a) => a.name },
            { key: 'capacity', header: 'Spaces', cell: (a) => <span className="t-num">{a.capacity}</span> },
            { key: 'state', header: '', cell: (a) => (a.active ? <Badge tone="green">Open</Badge> : <Badge tone="beige">Retired</Badge>) },
            {
              key: 'actions',
              header: '',
              className: 'table__actions',
              cell: (a) => (
                <span className="row" style={{ gap: 6 }}>
                  <Button size="sm" onClick={() => setEditing(a)}>
                    Edit
                  </Button>
                  <Button size="sm" loading={toggle.isPending && toggle.variables?.id === a.id} onClick={() => toggle.mutate(a)}>
                    {a.active ? 'Retire' : 'Reopen'}
                  </Button>
                </span>
              ),
            },
          ]}
        />
      </QueryState>
      <ErrorAlert error={toggle.error} />
      {editing ? <AreaDialog area={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function Settings() {
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.vehicleSettings, queryFn: fetchers.vehicleSettings });
  const [form, setForm] = useState<Record<SettingField, string>>({
    maxVehiclesPerUnit: '',
    visitorParkingMaxHours: '',
    maxActiveVisitorParkingBookings: '',
  });
  useEffect(() => {
    const s = settings.data;
    if (s)
      setForm({
        maxVehiclesPerUnit: String(s.maxVehiclesPerUnit),
        visitorParkingMaxHours: String(s.visitorParkingMaxHours),
        maxActiveVisitorParkingBookings: String(s.maxActiveVisitorParkingBookings),
      });
  }, [settings.data]);
  const fields = Object.keys(SETTING_RANGES) as SettingField[];
  const saved = settings.data;
  const changes = saved
    ? Object.fromEntries(fields.filter((f) => Number(form[f]) !== saved[f]).map((f) => [f, Number(form[f])]))
    : {};
  const valid = fields.every((f) => inRange(SETTING_RANGES[f], form[f]));
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/vehicle-settings', { body: changes })), {
    invalidate: [keys.vehicleSettings],
    onDone: () => toast.show('Settings saved. A lower limit leaves what a unit holds.'),
  });
  return (
    <Card>
      <CardHeader
        title="Limits"
        actions={
          <Button size="sm" variant="primary" disabled={!valid || Object.keys(changes).length === 0} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        }
      />
      <CardBody>
        <QueryState query={settings} rows={3}>
          <div className="form">
            {fields.map((f) => (
              <Field key={f} label={SETTING_TEXT[f].label} hint={SETTING_TEXT[f].hint} error={fieldError(save.error, f)}>
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={SETTING_RANGES[f].min}
                    max={SETTING_RANGES[f].max}
                    value={form[f]}
                    onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  />
                )}
              </Field>
            ))}
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

/**
 * Parking set-up (ADR 0045): the units’ own slots, the visitor areas and
 * the compound’s limits on vehicles and visitor bookings.
 */
export default function ParkingSetupPage() {
  const { ready, can } = usePermissions();
  const [tab, setTab] = useState<Tab>('slots');
  if (ready && !can('vehicles.manage'))
    return (
      <>
        <PageHeader title="Parking setup" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Parking setup" description="Slots belong to a unit; visitor areas take residents’ bookings for their visitors." />
      <div className="toolbar">
        <Segmented<Tab>
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'slots', label: 'Units’ slots' },
            { value: 'areas', label: 'Visitor areas' },
            { value: 'settings', label: 'Limits' },
          ]}
        />
      </div>
      {tab === 'slots' ? <Slots /> : tab === 'areas' ? <Areas /> : <Settings />}
    </>
  );
}
