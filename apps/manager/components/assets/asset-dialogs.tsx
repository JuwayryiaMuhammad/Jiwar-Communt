'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Alert, Button, DataTable, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { fetchers, keys, type AssetCard, type AssetImport } from '@/lib/queries';

const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
const CONDITIONS = ['good', 'fair', 'poor', 'critical'] as const;

/** A new asset: its code, type and place (an area, or a part of another). */
export function NewAssetDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const types = useQuery({ queryKey: keys.assetTypes, queryFn: fetchers.assetTypes });
  const areas = useQuery({ queryKey: keys.areas({ active: 'true' }), queryFn: () => fetchers.areas({ active: 'true' }) });
  const [code, setCode] = useState('');
  const [typeId, setTypeId] = useState('');
  const [place, setPlace] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [criticality, setCriticality] = useState<(typeof CRITICALITIES)[number]>('medium');
  const [commissionedOn, setCommissionedOn] = useState('');
  const [warrantyEndsOn, setWarrantyEndsOn] = useState('');
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/assets', {
          body: {
            code: code.trim(),
            typeId,
            commonAreaId: place,
            nameEn: nameEn.trim(),
            nameAr: nameAr.trim(),
            criticality,
            // A new asset is in good condition until someone records otherwise.
            condition: 'good',
            ...(commissionedOn ? { commissionedOn } : {}),
            ...(warrantyEndsOn ? { warrantyEndsOn } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.assetsAll],
      onDone: (a) => {
        toast.show(`${a.code} is added.`);
        router.push(`/assets/${a.id}`);
      },
    },
  );
  const ready = code.trim() !== '' && typeId !== '' && place !== '' && nameEn.trim() !== '' && nameAr.trim() !== '';
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New asset"
      description="An asset in a common area. Parts are added from the asset's page; assets in units are imported from a sheet."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Add asset
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label="Code" hint="Short and unique, e.g. PUMP-03. Never changes." error={fieldError(save.error, 'code')}>
            {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <Field label="Type" error={fieldError(save.error, 'typeId')}>
            {(p) => (
              <Select {...p} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                <option value="">Select…</option>
                {(types.data?.data ?? [])
                  .filter((t) => t.active)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nameEn}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Where" error={fieldError(save.error, 'commonAreaId')}>
          {(p) => (
            <Select {...p} value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="">Select a common area…</option>
              {(areas.data?.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form__row">
          <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
            {(p) => <Input {...p} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
          <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
            {(p) => <Input {...p} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label="Criticality">
            {(p) => (
              <Select {...p} value={criticality} onChange={(e) => setCriticality(e.target.value as (typeof CRITICALITIES)[number])}>
                {CRITICALITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="In service since" error={fieldError(save.error, 'commissionedOn')}>
            {(p) => <Input {...p} type="date" value={commissionedOn} onChange={(e) => setCommissionedOn(e.target.value)} />}
          </Field>
          <Field label="Warranty ends" error={fieldError(save.error, 'warrantyEndsOn')}>
            {(p) => <Input {...p} type="date" value={warrantyEndsOn} onChange={(e) => setWarrantyEndsOn(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The card's facts the manager edits. */
export function EditAssetDialog({ asset, onClose }: { asset: AssetCard; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    nameEn: asset.nameEn,
    nameAr: asset.nameAr,
    manufacturer: asset.manufacturer ?? '',
    model: asset.model ?? '',
    serialNumber: asset.serialNumber ?? '',
    vendorName: asset.vendorName ?? '',
    vendorPhone: asset.vendorPhone ?? '',
    warrantyEndsOn: asset.warrantyEndsOn ?? '',
    replacementCost: asset.replacementCost ?? '',
    criticality: asset.criticality,
    condition: asset.condition,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const orNull = (v: string) => (v.trim() === '' ? null : v.trim());
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/maintenance/assets/{id}', {
          params: { path: { id: asset.id } },
          body: {
            nameEn: f.nameEn.trim(),
            nameAr: f.nameAr.trim(),
            manufacturer: orNull(f.manufacturer),
            model: orNull(f.model),
            serialNumber: orNull(f.serialNumber),
            vendorName: orNull(f.vendorName),
            vendorPhone: orNull(f.vendorPhone),
            warrantyEndsOn: orNull(f.warrantyEndsOn),
            replacementCost: orNull(f.replacementCost),
            criticality: f.criticality,
            condition: f.condition,
          },
        }),
      ),
    {
      invalidate: [keys.asset(asset.id)],
      onDone: () => {
        toast.show(`${asset.code} is saved.`);
        onClose();
      },
    },
  );
  const field = (label: string, k: keyof typeof f, type = 'text') => (
    <Field label={label} error={fieldError(save.error, k)}>
      {(p) => <Input {...p} type={type} value={f[k]} onChange={set(k)} />}
    </Field>
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Edit ${asset.code}`}
      onSubmit={() => save.mutate()}
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
        <div className="form__row">
          {field('Name (English)', 'nameEn')}
          {field('Name (Arabic)', 'nameAr')}
        </div>
        <div className="form__row">
          {field('Manufacturer', 'manufacturer')}
          {field('Model', 'model')}
          {field('Serial number', 'serialNumber')}
        </div>
        <div className="form__row">
          {field('Vendor', 'vendorName')}
          {field('Vendor phone', 'vendorPhone')}
          {field('Warranty ends', 'warrantyEndsOn', 'date')}
        </div>
        <div className="form__row">
          {field('Replacement cost (EGP)', 'replacementCost')}
          <Field label="Criticality">
            {(p) => (
              <Select {...p} value={f.criticality} onChange={set('criticality')}>
                {CRITICALITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Condition">
            {(p) => (
              <Select {...p} value={f.condition} onChange={set('condition')}>
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/**
 * A sheet of assets: uploaded, checked whole (its problems by line and
 * column, never the cells), then applied once, every row or none.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [checked, setChecked] = useState<AssetImport | null>(null);
  const check = useAction(
    (fileId: string) => unwrap(api.POST('/api/v1/maintenance/asset-imports', { body: { fileId } })),
    { invalidate: [keys.assetImports], onDone: setChecked },
  );
  const apply = useAction(
    (id: string) => unwrap(api.POST('/api/v1/maintenance/asset-imports/{id}/apply', { params: { path: { id } } })),
    {
      invalidate: [keys.assetsAll],
      onDone: (done) => {
        setChecked(done);
        if (done.status === 'applied') toast.show(`${done.appliedCount} assets are added.`);
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Import assets"
      description="A CSV with a header row: code, type, name_ar, name_en, and unit (a unit's code), area (an area's code) or parent (an asset's code); optionally manufacturer, model, serial_number, commissioned_on, purchase_value, replacement_cost, expected_life_years, vendor_name, vendor_phone, warranty_ends_on, criticality, condition, serves_buildings (separated by ;)."
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
        <FileUpload purpose="data_import" label="Choose a sheet" disabled={check.isPending} onUploaded={(id) => check.mutateAsync(id).then(() => undefined)} />
        <ErrorAlert error={check.error} />
        <ErrorAlert error={apply.error} />
        {checked?.status === 'applied' ? <Alert tone="info">Applied: {checked.appliedCount} assets added.</Alert> : null}
        {checked?.status === 'valid' ? <Alert tone="info">The sheet is valid: {checked.rowCount} rows.</Alert> : null}
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
