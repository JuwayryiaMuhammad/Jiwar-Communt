'use client';

import { FieldErrorText, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  Input,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { fetchers, keys, type Building, type UnitDetail, type UnitHistory, type UnitImport } from '@/lib/queries';
import ar from '@/messages/ar/units-register';
import en from '@/messages/en/units-register';

const UNIT_TYPES = ['apartment', 'villa', 'townhouse', 'duplex', 'penthouse', 'studio', 'commercial', 'other'] as const;

/** The compound's buildings (ADR 0072): added ahead of their units, deleted when empty, never renamed. */
export function BuildingsCard() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const list = useQuery({ queryKey: keys.buildings, queryFn: () => fetchers.buildings() });
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Building | null>(null);
  const add = useAction(() => unwrap(api.POST('/api/v1/buildings', { body: { name: name.trim() } })), {
    invalidate: [keys.buildings],
    onDone: (b) => {
      toast.show(t('buildingAdded', { name: b.name }));
      setName('');
    },
  });
  const remove = useAction(
    (id: string) => unwrap(api.DELETE('/api/v1/buildings/{id}', { params: { path: { id } } })),
    {
      invalidate: [keys.buildings],
      onDone: () => {
        toast.show(t('buildingDeleted'));
        setRemoving(null);
      },
    },
  );
  return (
    <Card flush>
      <CardHeader title={t('buildings')} />
      <div className="form" style={{ padding: 16 }}>
        <div className="form__row">
          <Field label={t('newBuilding')} hint={t('newBuildingHint')} error={fieldError(add.error, 'name')}>
            {(p) => <Input {...p} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Button variant="primary" loading={add.isPending} disabled={!name.trim()} onClick={() => add.mutate(undefined)}>
            {c('add')}
          </Button>
        </div>
        <ErrorAlert error={add.error} />
      </div>
      <QueryState query={list}>
        <DataTable<Building>
          rows={list.data?.data ?? []}
          rowKey={(b) => b.id}
          empty={t('noBuildings')}
          emptyHint={t('noBuildingsHint')}
          columns={[
            { key: 'name', header: c('building'), cell: (b) => b.name },
            { key: 'units', header: t('col.units'), cell: (b) => <span className="t-num">{fmt.number(b.units)}</span> },
            { key: 'added', header: t('col.added'), cell: (b) => fmt.date(b.createdAt) },
            {
              key: 'actions',
              header: '',
              cell: (b) =>
                b.units === 0 ? (
                  <Button size="sm" variant="text" onClick={() => setRemoving(b)}>
                    {c('delete')}
                  </Button>
                ) : null,
            },
          ]}
        />
      </QueryState>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        title={t('deleteTitle', { name: removing?.name ?? t('theBuilding') })}
        description={t('deleteDescription')}
        confirmLabel={c('delete')}
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </Card>
  );
}

/** Edit a unit (ADR 0072): building, floor, type and area; never the code. */
export function EditUnitDialog({ unit, onClose }: { unit: UnitDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const buildings = useQuery({ queryKey: keys.buildings, queryFn: () => fetchers.buildings() });
  const [form, setForm] = useState({
    buildingId: unit.buildingId ?? '',
    floor: unit.floor == null ? '' : String(unit.floor),
    unitType: unit.unitType ?? '',
    areaSqm: unit.areaSqm ?? '',
  });
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/units/{id}', {
          params: { path: { id: unit.id } },
          body: {
            buildingId: form.buildingId || null,
            floor: form.floor.trim() ? Number(form.floor) : null,
            unitType: (form.unitType || null) as UnitDetail['unitType'],
            areaSqm: form.areaSqm.trim() || null,
          },
        }),
      ),
    {
      invalidate: [keys.units, keys.buildings],
      onDone: () => {
        toast.show(t('unitSaved', { code: unit.code }));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('editTitle', { code: unit.code })}
      description={t('editDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('building')} error={fieldError(save.error, 'buildingId')}>
          {(p) => (
            <Select {...p} value={form.buildingId} onChange={(e) => setForm({ ...form, buildingId: e.target.value })}>
              <option value="">{t('noBuilding')}</option>
              {(buildings.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form__row">
          <Field label={c('floor')} error={fieldError(save.error, 'floor')}>
            {(p) => <Input {...p} type="number" inputMode="numeric" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} />}
          </Field>
          <Field label={t('area')} error={fieldError(save.error, 'areaSqm')}>
            {(p) => <Input {...p} inputMode="decimal" value={form.areaSqm} onChange={(e) => setForm({ ...form, areaSqm: e.target.value })} />}
          </Field>
        </div>
        <Field label={c('type')} error={fieldError(save.error, 'unitType')}>
          {(p) => (
            <Select {...p} value={form.unitType} onChange={(e) => setForm({ ...form, unitType: e.target.value })}>
              <option value="">{t('notSet')}</option>
              {UNIT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {label(type)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** Every place held in the unit, live or ended (ADR 0072). */
export function UnitHistoryCard({ unitId }: { unitId: string }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const list = useCursorList(keys.unitHistory(unitId), (cursor) => fetchers.unitHistory(unitId, cursor));
  return (
    <Card flush>
      <CardHeader title={t('history')} />
      <QueryState query={list}>
        <DataTable<UnitHistory>
          rows={list.rows}
          rowKey={(o) => o.occupancyId}
          empty={t('historyEmpty')}
          columns={[
            {
              key: 'who',
              header: t('col.who'),
              cell: (o) => (
                <Link className="table__link" href={`/residents/${o.account.id}`}>
                  {o.account.fullName ?? t('erased')}
                </Link>
              ),
            },
            {
              key: 'as',
              header: t('col.as'),
              cell: (o) => (o.resides ? label(o.occupancyType) : t('notLiving', { type: label(o.occupancyType) })),
            },
            { key: 'from', header: c('from'), cell: (o) => fmt.date(o.startedAt) },
            { key: 'to', header: c('to'), cell: (o) => (o.endedAt ? fmt.date(o.endedAt) : t('now')) },
            { key: 'why', header: t('col.ended'), cell: (o) => (o.endReason ? label(o.endReason) : '—') },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

/** The unit's workers, as the manager reviews them (ADR 0072). */
export function UnitWorkersCard({ unitId }: { unitId: string }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const list = useQuery({ queryKey: keys.unitWorkers(unitId), queryFn: () => fetchers.unitWorkers(unitId) });
  return (
    <Card flush>
      <CardHeader title={t('workers')} />
      <QueryState query={list}>
        <DataTable
          rows={list.data?.data ?? []}
          rowKey={(e) => e.id}
          empty={t('workersEmpty')}
          columns={[
            {
              key: 'worker',
              header: t('col.worker'),
              cell: (e) => (
                <Link className="table__link" href="/workers">
                  {e.workerName}
                </Link>
              ),
            },
            { key: 'capacity', header: t('col.as'), cell: (e) => label(e.capacity) },
            { key: 'status', header: c('status'), cell: (e) => label(e.status) },
          ]}
        />
      </QueryState>
    </Card>
  );
}

/** A sheet of units or residents (ADR 0072): checked whole, then applied once. */
export function UnitImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const [kind, setKind] = useState<'units' | 'residents'>('units');
  const [checked, setChecked] = useState<UnitImport | null>(null);
  const check = useAction(
    (fileId: string) => unwrap(api.POST('/api/v1/staff/unit-imports', { body: { kind, fileId } })),
    { invalidate: [keys.unitImports], onDone: setChecked },
  );
  const apply = useAction(
    (id: string) => unwrap(api.POST('/api/v1/staff/unit-imports/{id}/apply', { params: { path: { id } } })),
    {
      invalidate: [keys.units, keys.residents, keys.buildings, keys.unitImports],
      onDone: (done) => {
        setChecked(done);
        if (done.status === 'applied')
          toast.show(kind === 'units' ? t('unitsAdded', { n: done.appliedCount }) : t('residentsAdded', { n: done.appliedCount }));
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('importTitle')}
      description={kind === 'units' ? t('importUnitsHelp') : t('importResidentsHelp')}
      footer={
        <>
          <Button onClick={onClose}>{c('close')}</Button>
          {checked?.status === 'valid' ? (
            <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate(checked.id)}>
              {t('applyRows', { n: checked.rowCount })}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form">
        <Segmented
          label={t('sheet')}
          value={kind}
          onChange={(v) => {
            setKind(v);
            setChecked(null);
            check.reset();
          }}
          options={[
            { value: 'units', label: t('kind.units') },
            { value: 'residents', label: t('kind.residents') },
          ]}
        />
        <FileUpload purpose="data_import" label={t('chooseSheet')} disabled={check.isPending} onUploaded={(id) => check.mutateAsync(id).then(() => undefined)} />
        <ErrorAlert error={check.error} />
        <ErrorAlert error={apply.error} />
        {checked?.status === 'applied' ? <Alert tone="info">{t('applied', { n: checked.appliedCount })}</Alert> : null}
        {checked?.status === 'valid' ? <Alert tone="info">{t('valid', { n: checked.rowCount })}</Alert> : null}
        {checked?.status === 'expired' ? <Alert tone="warn">{t('expired')}</Alert> : null}
        {checked?.status === 'invalid' ? (
          <>
            <Alert tone="error">{t('invalid', { n: checked.errorCount })}</Alert>
            <DataTable
              rows={checked.errors}
              rowKey={(e) => `${e.line}:${e.field}:${e.code}`}
              columns={[
                { key: 'line', header: t('col.line'), width: 70, cell: (e) => <span className="t-num">{fmt.number(e.line)}</span> },
                { key: 'field', header: t('col.column'), cell: (e) => <span className="t-mono">{e.field}</span> },
                { key: 'code', header: t('col.problem'), cell: (e) => <FieldErrorText code={e.code} /> },
              ]}
            />
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
