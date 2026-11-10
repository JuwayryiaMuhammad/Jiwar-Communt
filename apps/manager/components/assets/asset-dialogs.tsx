'use client';

import { FieldErrorText, fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, DataTable, Dialog, Field, Input, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { fetchers, keys, type AssetCard, type AssetImport } from '@/lib/queries';
import ar from '@/messages/ar/assets-register';
import en from '@/messages/en/assets-register';
import { nameOf } from './format';

const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
const CONDITIONS = ['good', 'fair', 'poor', 'critical'] as const;

/** A new asset: its code, type and place (an area, or a part of another). */
export function NewAssetDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
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
        toast.show(t('added', { code: a.code }));
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
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('addAsset')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label={t('code')} hint={t('codeHint')} error={fieldError(save.error, 'code')}>
            {(p) => <Input {...p} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <Field label={t('type')} error={fieldError(save.error, 'typeId')}>
            {(p) => (
              <Select {...p} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                <option value="">{c('select')}</option>
                {(types.data?.data ?? [])
                  .filter((x) => x.active)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {nameOf(fmt.locale, x)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('where')} error={fieldError(save.error, 'commonAreaId')}>
          {(p) => (
            <Select {...p} value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="">{t('pickArea')}</option>
              {(areas.data?.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {nameOf(fmt.locale, a)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form__row">
          <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
            {(p) => <Input {...p} dir="ltr" lang="en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
          <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
            {(p) => <Input {...p} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label={t('criticality')}>
            {(p) => (
              <Select {...p} value={criticality} onChange={(e) => setCriticality(e.target.value as (typeof CRITICALITIES)[number])}>
                {CRITICALITIES.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('commissionedOn')} error={fieldError(save.error, 'commissionedOn')}>
            {(p) => <Input {...p} type="date" value={commissionedOn} onChange={(e) => setCommissionedOn(e.target.value)} />}
          </Field>
          <Field label={t('warrantyEndsOn')} error={fieldError(save.error, 'warrantyEndsOn')}>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
    warrantyStartsOn: asset.warrantyStartsOn ?? '',
    warrantor: asset.warrantor ?? '',
    warrantyCovers: asset.warrantyCovers ?? '',
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
            warrantyStartsOn: orNull(f.warrantyStartsOn),
            warrantor: orNull(f.warrantor),
            warrantyCovers: orNull(f.warrantyCovers),
            replacementCost: orNull(f.replacementCost),
            criticality: f.criticality,
            condition: f.condition,
          },
        }),
      ),
    {
      invalidate: [keys.asset(asset.id)],
      onDone: () => {
        toast.show(t('saved', { code: asset.code }));
        onClose();
      },
    },
  );
  const field = (text: string, k: keyof typeof f, type = 'text', dir?: 'ltr' | 'rtl') => (
    <Field label={text} error={fieldError(save.error, k)}>
      {(p) => <Input {...p} type={type} dir={dir} value={f[k]} onChange={set(k)} />}
    </Field>
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('editTitle', { code: asset.code })}
      onSubmit={() => save.mutate()}
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
        <div className="form__row">
          {field(t('nameEn'), 'nameEn', 'text', 'ltr')}
          {field(t('nameAr'), 'nameAr', 'text', 'rtl')}
        </div>
        <div className="form__row">
          {field(t('manufacturer'), 'manufacturer')}
          {field(t('model'), 'model')}
          {field(t('serialNumber'), 'serialNumber', 'text', 'ltr')}
        </div>
        <div className="form__row">
          {field(t('vendor'), 'vendorName')}
          {field(t('vendorPhone'), 'vendorPhone', 'text', 'ltr')}
        </div>
        <div className="form__row">
          {field(t('warrantyStartsOn'), 'warrantyStartsOn', 'date')}
          {field(t('warrantyEndsOn'), 'warrantyEndsOn', 'date')}
          {field(t('warrantor'), 'warrantor')}
        </div>
        <div className="form__row">{field(t('warrantyCovers'), 'warrantyCovers')}</div>
        <div className="form__row">
          {field(t('replacementCost'), 'replacementCost', 'text', 'ltr')}
          <Field label={t('criticality')}>
            {(p) => (
              <Select {...p} value={f.criticality} onChange={set('criticality')}>
                {CRITICALITIES.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('condition')}>
            {(p) => (
              <Select {...p} value={f.condition} onChange={set('condition')}>
                {CONDITIONS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
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
  const t = useT(en, ar);
  const c = useCommonT();
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
        if (done.status === 'applied') toast.show(t('importDone', { n: done.appliedCount }));
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('importTitle')}
      description={t('importDescription')}
      footer={
        <>
          <Button onClick={onClose}>{c('close')}</Button>
          {checked?.status === 'valid' ? (
            <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate(checked.id)}>
              {t('apply', { n: checked.rowCount })}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form">
        <FileUpload purpose="data_import" label={t('chooseSheet')} disabled={check.isPending} onUploaded={(id) => check.mutateAsync(id).then(() => undefined)} />
        <ErrorAlert error={check.error} />
        <ErrorAlert error={apply.error} />
        {checked?.status === 'applied' ? <Alert tone="info">{t('applied', { n: checked.appliedCount })}</Alert> : null}
        {checked?.status === 'valid' ? <Alert tone="info">{t('valid', { n: checked.rowCount })}</Alert> : null}
        {checked?.status === 'invalid' ? (
          <>
            <Alert tone="error">{t('invalid', { n: checked.errorCount })}</Alert>
            <DataTable
              rows={checked.errors}
              rowKey={(e) => `${e.line}:${e.field}:${e.code}`}
              columns={[
                { key: 'line', header: t('col.line'), width: 70, cell: (e) => <span className="t-num">{e.line}</span> },
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
