'use client';

import { formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { fetchers, keys, type Building, type UnitDetail, type UnitHistory, type UnitImport } from '@/lib/queries';

const UNIT_TYPES = ['apartment', 'villa', 'townhouse', 'duplex', 'penthouse', 'studio', 'commercial', 'other'] as const;

/** The compound's buildings (ADR 0072): added ahead of their units, deleted when empty, never renamed. */
export function BuildingsCard() {
  const toast = useToast();
  const list = useQuery({ queryKey: keys.buildings, queryFn: () => fetchers.buildings() });
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Building | null>(null);
  const add = useAction(() => unwrap(api.POST('/api/v1/buildings', { body: { name: name.trim() } })), {
    invalidate: [keys.buildings],
    onDone: (b) => {
      toast.show(`Building ${b.name} added.`);
      setName('');
    },
  });
  const remove = useAction(
    (id: string) => unwrap(api.DELETE('/api/v1/buildings/{id}', { params: { path: { id } } })),
    {
      invalidate: [keys.buildings],
      onDone: () => {
        toast.show('Building deleted.');
        setRemoving(null);
      },
    },
  );
  return (
    <Card flush>
      <CardHeader title="Buildings" />
      <div className="form" style={{ padding: 16 }}>
        <div className="form__row">
          <Field label="New building" hint="Never renamed: audiences and service areas keep the name." error={fieldError(add.error, 'name')}>
            {(p) => <Input {...p} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Button variant="primary" loading={add.isPending} disabled={!name.trim()} onClick={() => add.mutate(undefined)}>
            Add
          </Button>
        </div>
        <ErrorAlert error={add.error} />
      </div>
      <QueryState query={list}>
        <DataTable<Building>
          rows={list.data?.data ?? []}
          rowKey={(b) => b.id}
          empty="No buildings yet"
          emptyHint="A unit added with a building's name brings the building."
          columns={[
            { key: 'name', header: 'Building', cell: (b) => b.name },
            { key: 'units', header: 'Units', cell: (b) => <span className="t-num">{b.units}</span> },
            { key: 'added', header: 'Added', cell: (b) => formatDate(b.createdAt) },
            {
              key: 'actions',
              header: '',
              cell: (b) =>
                b.units === 0 ? (
                  <Button size="sm" variant="text" onClick={() => setRemoving(b)}>
                    Delete
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
        title={`Delete ${removing?.name ?? 'the building'}?`}
        description="Only a building no unit names can be deleted."
        confirmLabel="Delete"
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
        toast.show(`Unit ${unit.code} saved.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit unit ${unit.code}`}
      description="The code stays as it is: QR codes, permits and certificates print it."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Building" error={fieldError(save.error, 'buildingId')}>
          {(p) => (
            <Select {...p} value={form.buildingId} onChange={(e) => setForm({ ...form, buildingId: e.target.value })}>
              <option value="">None</option>
              {(buildings.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form__row">
          <Field label="Floor" error={fieldError(save.error, 'floor')}>
            {(p) => <Input {...p} type="number" inputMode="numeric" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} />}
          </Field>
          <Field label="Area (m²)" error={fieldError(save.error, 'areaSqm')}>
            {(p) => <Input {...p} inputMode="decimal" value={form.areaSqm} onChange={(e) => setForm({ ...form, areaSqm: e.target.value })} />}
          </Field>
        </div>
        <Field label="Type" error={fieldError(save.error, 'unitType')}>
          {(p) => (
            <Select {...p} value={form.unitType} onChange={(e) => setForm({ ...form, unitType: e.target.value })}>
              <option value="">Not set</option>
              {UNIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
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
  const list = useCursorList(keys.unitHistory(unitId), (c) => fetchers.unitHistory(unitId, c));
  return (
    <Card flush>
      <CardHeader title="Occupancy history" />
      <QueryState query={list}>
        <DataTable<UnitHistory>
          rows={list.rows}
          rowKey={(o) => o.occupancyId}
          empty="Nobody has held a place here yet"
          columns={[
            {
              key: 'who',
              header: 'Who',
              cell: (o) => (
                <Link className="table__link" href={`/residents/${o.account.id}`}>
                  {o.account.fullName ?? 'Erased account'}
                </Link>
              ),
            },
            { key: 'as', header: 'As', cell: (o) => `${humanize(o.occupancyType)}${o.resides ? '' : ' (not living there)'}` },
            { key: 'from', header: 'From', cell: (o) => formatDate(o.startedAt) },
            { key: 'to', header: 'To', cell: (o) => (o.endedAt ? formatDate(o.endedAt) : 'Now') },
            { key: 'why', header: 'Ended', cell: (o) => (o.endReason ? humanize(o.endReason) : '—') },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

/** The unit's workers, as the manager reviews them (ADR 0072). */
export function UnitWorkersCard({ unitId }: { unitId: string }) {
  const list = useQuery({ queryKey: keys.unitWorkers(unitId), queryFn: () => fetchers.unitWorkers(unitId) });
  return (
    <Card flush>
      <CardHeader title="Workers" />
      <QueryState query={list}>
        <DataTable
          rows={list.data?.data ?? []}
          rowKey={(e) => e.id}
          empty="No workers registered"
          columns={[
            {
              key: 'worker',
              header: 'Worker',
              cell: (e) => (
                <Link className="table__link" href="/workers">
                  {e.workerName}
                </Link>
              ),
            },
            { key: 'capacity', header: 'As', cell: (e) => humanize(e.capacity) },
            { key: 'status', header: 'Status', cell: (e) => humanize(e.status) },
          ]}
        />
      </QueryState>
    </Card>
  );
}

/** A sheet of units or residents (ADR 0072): checked whole, then applied once. */
export function UnitImportDialog({ onClose }: { onClose: () => void }) {
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
        if (done.status === 'applied') toast.show(`${done.appliedCount} ${kind} added.`);
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Import units or residents"
      description={
        kind === 'units'
          ? 'A CSV with a header row: code, and optionally building (a name), floor, unit_type, area_sqm. Up to 2000 rows.'
          : 'A CSV with a header row: full_name, phone, email, id_document_type, id_document_number, unit (a code), occupancy_type, and optionally nationality, birth_date, resides (true or false), preferred_locale. One row a person and unit; up to 300 rows. No one is emailed. The sheet is deleted once applied, found invalid, or a day old.'
      }
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {checked?.status === 'valid' ? (
            <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate(checked.id)}>
              Apply {checked.rowCount} rows
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form">
        <Segmented
          label="Sheet"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setChecked(null);
            check.reset();
          }}
          options={[
            { value: 'units', label: 'Units' },
            { value: 'residents', label: 'Residents' },
          ]}
        />
        <FileUpload purpose="data_import" label="Choose a sheet" disabled={check.isPending} onUploaded={(id) => check.mutateAsync(id).then(() => undefined)} />
        <ErrorAlert error={check.error} />
        <ErrorAlert error={apply.error} />
        {checked?.status === 'applied' ? <Alert tone="info">Applied: {checked.appliedCount} added.</Alert> : null}
        {checked?.status === 'valid' ? <Alert tone="info">The sheet is valid: {checked.rowCount} rows. Apply it within a day.</Alert> : null}
        {checked?.status === 'expired' ? <Alert tone="warn">More than a day passed: upload the sheet again.</Alert> : null}
        {checked?.status === 'invalid' ? (
          <>
            <Alert tone="error">
              {checked.errorCount} problem{checked.errorCount === 1 ? '' : 's'}; nothing was added. Fix the sheet and upload it again.
            </Alert>
            <DataTable
              rows={checked.errors}
              rowKey={(e) => `${e.line}:${e.field}:${e.code}`}
              columns={[
                { key: 'line', header: 'Line', width: 70, cell: (e) => <span className="t-num">{e.line}</span> },
                { key: 'field', header: 'Column', cell: (e) => <span className="t-mono">{e.field}</span> },
                { key: 'code', header: 'Problem', cell: (e) => e.code.replace(/_/g, ' ').toLowerCase() },
              ]}
            />
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
