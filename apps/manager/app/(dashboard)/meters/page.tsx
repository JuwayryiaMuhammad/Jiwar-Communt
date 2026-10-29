'use client';

import { fieldError, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Meter, type MeterReadingImport } from '@/lib/queries';

const KINDS = ['electricity', 'water', 'gas', 'fuel', 'run_hours'] as const;
type Kind = (typeof KINDS)[number] | '';

function NewMeterDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const areas = useQuery({ queryKey: keys.areas({ active: 'true' }), queryFn: () => fetchers.areas({ active: 'true' }) });
  const units = useQuery({ queryKey: keys.units, queryFn: () => fetchers.units(undefined, 100) });
  const [place, setPlace] = useState<'area' | 'unit'>('area');
  const [f, setF] = useState({
    code: '',
    kind: 'water' as (typeof KINDS)[number],
    mode: 'cumulative' as 'cumulative' | 'interval',
    multiplier: '1',
    commonAreaId: '',
    unitId: '',
    serial: '',
    installedOn: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/meters', {
          body: {
            code: f.code.trim(),
            kind: f.kind,
            mode: f.mode,
            multiplier: f.multiplier,
            ...(place === 'area' ? { commonAreaId: f.commonAreaId } : { unitId: f.unitId }),
            ...(f.serial.trim() ? { serial: f.serial.trim() } : {}),
            ...(f.installedOn ? { installedOn: f.installedOn } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.energyAll],
      onDone: (m) => {
        toast.show(`${m.code} is added.`);
        router.push(`/meters/${m.id}`);
      },
    },
  );
  const ready = f.code.trim() && (place === 'area' ? f.commonAreaId : f.unitId);
  return (
    <Dialog
      open
      onClose={onClose}
      title="New meter"
      description="A meter keeps its kind, mode, multiplier and place for life."
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
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label="Code" error={fieldError(save.error, 'code')}>
            {(p) => <Input {...p} value={f.code} onChange={set('code')} />}
          </Field>
          <Field label="Kind" error={fieldError(save.error, 'kind')}>
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
        </div>
        <div className="form__row">
          <Field label="Mode" hint="Cumulative: the register as it stands." error={fieldError(save.error, 'mode')}>
            {(p) => (
              <Select {...p} value={f.mode} onChange={set('mode')}>
                <option value="cumulative">Cumulative</option>
                <option value="interval">Interval</option>
              </Select>
            )}
          </Field>
          <Field label="Multiplier" error={fieldError(save.error, 'multiplier')}>
            {(p) => <Input {...p} value={f.multiplier} onChange={set('multiplier')} />}
          </Field>
        </div>
        <Segmented<'area' | 'unit'>
          label="Where"
          value={place}
          onChange={setPlace}
          options={[
            { value: 'area', label: 'A common area' },
            { value: 'unit', label: 'A unit' },
          ]}
        />
        {place === 'area' ? (
          <Field label="Common area" error={fieldError(save.error, 'commonAreaId')}>
            {(p) => (
              <Select {...p} value={f.commonAreaId} onChange={set('commonAreaId')}>
                <option value="">Choose…</option>
                {(areas.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field label="Unit" error={fieldError(save.error, 'unitId')}>
            {(p) => (
              <Select {...p} value={f.unitId} onChange={set('unitId')}>
                <option value="">Choose…</option>
                {(units.data?.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="form__row">
          <Field label="Serial" error={fieldError(save.error, 'serial')}>
            {(p) => <Input {...p} value={f.serial} onChange={set('serial')} />}
          </Field>
          <Field label="Installed on" error={fieldError(save.error, 'installedOn')}>
            {(p) => <Input {...p} type="date" value={f.installedOn} onChange={set('installedOn')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [checked, setChecked] = useState<MeterReadingImport | null>(null);
  const check = useAction(
    (fileId: string) => unwrap(api.POST('/api/v1/maintenance/meter-reading-imports', { body: { fileId } })),
    { invalidate: [keys.readingImports], onDone: (i) => setChecked(i) },
  );
  const apply = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/meter-reading-imports/{id}/apply', { params: { path: { id: checked!.id } } })),
    {
      invalidate: [keys.energyAll],
      onDone: (i) => {
        setChecked(i);
        if (i.status === 'applied') toast.show(`${i.appliedCount} readings imported.`);
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Import readings"
      description="A CSV with the columns meter, read_on, value and, if the register was reset, reset. Checked whole, then applied once."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {checked?.status === 'valid' ? (
            <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>
              Apply {checked.rowCount} readings
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={check.error ?? apply.error} />
        {checked ? null : (
          <FileUpload purpose="data_import" label="Choose the sheet" disabled={check.isPending} onUploaded={(f) => check.mutateAsync(f).then(() => undefined)} />
        )}
        {checked ? (
          <p>
            {humanize(checked.status)} · {checked.rowCount} rows · {checked.errorCount} problems
          </p>
        ) : null}
        {checked && checked.errors.length ? (
          <DataTable
            rows={checked.errors}
            rowKey={(e) => `${e.line}-${e.field}`}
            columns={[
              { key: 'l', header: 'Line', cell: (e) => e.line },
              { key: 'f', header: 'Column', cell: (e) => e.field },
              { key: 'c', header: 'Problem', cell: (e) => humanize(e.code) },
            ]}
          />
        ) : null}
      </div>
    </Dialog>
  );
}

/** The compound's meters (ADR 0066). */
export default function MetersPage() {
  const { ready, can } = usePermissions();
  const [kind, setKind] = useState<Kind>('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const filters = { kind, active: 'true' as const };
  const list = useCursorList(keys.meters(filters), (c) => fetchers.meters(filters, c), { enabled: can('energy.read') });
  if (ready && !can('energy.read'))
    return (
      <>
        <PageHeader title="Meters" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Meters"
        description="Electricity, water, gas, fuel and running hours, read by hand, by sheet or by a technician."
        actions={
          can('energy.manage') ? (
            <>
              <Button onClick={() => setImporting(true)}>Import readings</Button>
              <Button variant="primary" onClick={() => setCreating(true)}>
                New meter
              </Button>
            </>
          ) : null
        }
      />
      <div className="toolbar">
        <Segmented<Kind>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[{ value: '', label: 'All' }, ...KINDS.map((k) => ({ value: k as Kind, label: humanize(k) }))]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Meter>
            rows={list.rows}
            rowKey={(m) => m.id}
            empty="No meter"
            columns={[
              {
                key: 'c',
                header: 'Code',
                cell: (m) => (
                  <Link className="table__link" href={`/meters/${m.id}`}>
                    {m.code}
                  </Link>
                ),
              },
              { key: 'k', header: 'Kind', cell: (m) => `${humanize(m.kind)} (${m.unit})` },
              { key: 'm', header: 'Mode', cell: (m) => humanize(m.mode) },
              { key: 'w', header: 'Where', cell: (m) => (m.unitId ? 'A unit' : 'A common area') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewMeterDialog onClose={() => setCreating(false)} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </>
  );
}
