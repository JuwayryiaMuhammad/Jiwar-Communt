'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { inRange } from '@/components/facilities/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ParkingSlot, type VisitorArea } from '@/lib/queries';
import ar from '@/messages/ar/safety-parking';
import en from '@/messages/en/safety-parking';

const TABS = ['slots', 'areas', 'settings'] as const;
type Tab = (typeof TABS)[number];
const SETTING_RANGES = {
  maxVehiclesPerUnit: { min: 1, max: 20 },
  visitorParkingMaxHours: { min: 1, max: 24 },
  maxActiveVisitorParkingBookings: { min: 1, max: 20 },
} as const;
type SettingField = keyof typeof SETTING_RANGES;

function SlotDialog({ slot, onClose }: { slot: ParkingSlot | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(slot ? t('slotSaved') : t('slotGiven'));
        onClose();
      },
    },
  );
  const ready = (slot || unitCode.trim()) && code.trim() && place.trim();
  return (
    <Dialog
      open
      onClose={onClose}
      title={slot ? t('slotTitle', { code: slot.code, unit: slot.unitCode }) : t('newSlotTitle')}
      description={t('slotDescription')}
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
        {slot ? null : (
          <Field label={t('unitCode')} error={fieldError(save.error, 'unitCode')}>
            {(p) => <Input {...p} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
          </Field>
        )}
        <Field label={t('slotCode')} hint={t('onceInCompound')} error={fieldError(save.error, 'code')}>
          {(p) => <Input {...p} maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field label={t('place')} hint={t('placeHint')} error={fieldError(save.error, 'place')}>
          {(p) => <Input {...p} maxLength={80} value={place} onChange={(e) => setPlace(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Slots() {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [unitCode, setUnitCode] = useState('');
  const [editing, setEditing] = useState<ParkingSlot | 'new' | null>(null);
  const list = useCursorList(keys.parkingSlots(unitCode.trim()), (cursor) => fetchers.parkingSlots(unitCode.trim(), cursor));
  const remove = useAction(
    (id: string) => unwrap(api.DELETE('/api/v1/staff/parking-slots/{id}', { params: { path: { id } } })),
    { invalidate: [keys.parkingSlotsAll], onDone: () => toast.show(t('slotTakenAway')) },
  );
  return (
    <Card flush>
      <CardHeader
        title={t('slotsTitle')}
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            {t('giveSlot')}
          </Button>
        }
      />
      <CardBody>
        <Field label={t('unitCode')}>
          {(p) => <Input {...p} placeholder={t('everyUnit')} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </CardBody>
      <QueryState query={list}>
        <DataTable<ParkingSlot>
          rows={list.rows}
          rowKey={(s) => s.id}
          empty={t('emptySlots')}
          columns={[
            { key: 'unit', header: t('col.unit'), cell: (s) => <span className="t-mono">{s.unitCode}</span> },
            { key: 'code', header: t('col.slot'), cell: (s) => <span className="t-mono">{s.code}</span> },
            { key: 'place', header: t('col.place'), cell: (s) => s.place },
            {
              key: 'actions',
              header: '',
              className: 'table__actions',
              cell: (s) => (
                <span className="row" style={{ gap: 6 }}>
                  <Button size="sm" onClick={() => setEditing(s)}>
                    {c('edit')}
                  </Button>
                  <Button size="sm" variant="danger" loading={remove.isPending && remove.variables === s.id} onClick={() => remove.mutate(s.id)}>
                    {t('takeAway')}
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
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('areaSaved'));
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
      title={area ? t('areaTitle', { name: area.name }) : t('newAreaTitle')}
      description={t('areaDescription')}
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
        <Field label={t('name')} hint={t('onceInCompound')} error={fieldError(save.error, 'name')}>
          {(p) => <Input {...p} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field
          label={t('spaces')}
          hint={t('spacesHint')}
          error={fieldError(save.error, 'capacity') ?? (capacity && !okCapacity ? t('spacesHint') : undefined)}
        >
          {(p) => <Input {...p} type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Areas() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const areas = useQuery({ queryKey: keys.visitorAreas, queryFn: fetchers.visitorAreas });
  const [editing, setEditing] = useState<VisitorArea | 'new' | null>(null);
  const toggle = useAction(
    (a: VisitorArea) =>
      unwrap(api.PATCH('/api/v1/staff/visitor-parking-areas/{id}', { params: { path: { id: a.id } }, body: { active: !a.active } })),
    { invalidate: [keys.visitorAreas], onDone: (a) => toast.show(a.active ? t('areaReopened') : t('areaRetired')) },
  );
  return (
    <Card flush>
      <CardHeader
        title={t('areasTitle')}
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            {t('newArea')}
          </Button>
        }
      />
      <QueryState query={areas}>
        <DataTable<VisitorArea>
          rows={areas.data?.data}
          rowKey={(a) => a.id}
          empty={t('emptyAreas')}
          columns={[
            { key: 'name', header: t('col.area'), cell: (a) => a.name },
            { key: 'capacity', header: t('col.spaces'), cell: (a) => <span className="t-num">{fmt.number(a.capacity)}</span> },
            { key: 'state', header: '', cell: (a) => (a.active ? <Badge tone="green">{t('open')}</Badge> : <Badge tone="beige">{t('retired')}</Badge>) },
            {
              key: 'actions',
              header: '',
              className: 'table__actions',
              cell: (a) => (
                <span className="row" style={{ gap: 6 }}>
                  <Button size="sm" onClick={() => setEditing(a)}>
                    {c('edit')}
                  </Button>
                  <Button size="sm" loading={toggle.isPending && toggle.variables?.id === a.id} onClick={() => toggle.mutate(a)}>
                    {a.active ? t('retire') : t('reopen')}
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
  const t = useT(en, ar);
  const c = useCommonT();
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
    onDone: () => toast.show(t('settingsSaved')),
  });
  return (
    <Card>
      <CardHeader
        title={t('limits')}
        actions={
          <Button size="sm" variant="primary" disabled={!valid || Object.keys(changes).length === 0} loading={save.isPending} onClick={() => save.mutate()}>
            {c('save')}
          </Button>
        }
      />
      <CardBody>
        <QueryState query={settings} rows={3}>
          <div className="form">
            {fields.map((f) => (
              <Field key={f} label={t(`setting.${f}.label`)} hint={t(`setting.${f}.hint`)} error={fieldError(save.error, f)}>
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
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const [tab, setTab] = useState<Tab>('slots');
  if (ready && !can('vehicles.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<Tab> label={t('section')} value={tab} onChange={setTab} options={TABS.map((v) => ({ value: v, label: t(`tab.${v}`) }))} />
      </div>
      {tab === 'slots' ? <Slots /> : tab === 'areas' ? <Areas /> : <Settings />}
    </>
  );
}
