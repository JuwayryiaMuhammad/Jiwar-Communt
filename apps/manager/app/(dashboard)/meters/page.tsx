'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Meter, type MeterReadingImport } from '@/lib/queries';
import ar from '@/messages/ar/meters';
import en from '@/messages/en/meters';

const KINDS = ['electricity', 'water', 'gas', 'fuel', 'run_hours'] as const;
type Kind = (typeof KINDS)[number] | '';

function NewMeterDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const { locale } = useLocale();
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
        toast.show(t('added', { code: m.code }));
        router.push(`/meters/${m.id}`);
      },
    },
  );
  const ready = f.code.trim() && (place === 'area' ? f.commonAreaId : f.unitId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label={t('code')} error={fieldError(save.error, 'code')}>
            {(p) => <Input {...p} dir="ltr" value={f.code} onChange={set('code')} />}
          </Field>
          <Field label={t('kind')} error={fieldError(save.error, 'kind')}>
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
        </div>
        <div className="form__row">
          <Field label={t('mode')} hint={t('modeHint')} error={fieldError(save.error, 'mode')}>
            {(p) => (
              <Select {...p} value={f.mode} onChange={set('mode')}>
                <option value="cumulative">{label('cumulative')}</option>
                <option value="interval">{label('interval')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('multiplier')} error={fieldError(save.error, 'multiplier')}>
            {(p) => <Input {...p} value={f.multiplier} onChange={set('multiplier')} />}
          </Field>
        </div>
        <Segmented<'area' | 'unit'>
          label={t('where')}
          value={place}
          onChange={setPlace}
          options={[
            { value: 'area', label: t('placeArea') },
            { value: 'unit', label: t('placeUnit') },
          ]}
        />
        {place === 'area' ? (
          <Field label={t('commonArea')} error={fieldError(save.error, 'commonAreaId')}>
            {(p) => (
              <Select {...p} value={f.commonAreaId} onChange={set('commonAreaId')}>
                <option value="">{t('choose')}</option>
                {(areas.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {locale === 'ar' && a.nameAr ? a.nameAr : a.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field label={t('unit')} error={fieldError(save.error, 'unitId')}>
            {(p) => (
              <Select {...p} value={f.unitId} onChange={set('unitId')}>
                <option value="">{t('choose')}</option>
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
          <Field label={t('serial')} error={fieldError(save.error, 'serial')}>
            {(p) => <Input {...p} value={f.serial} onChange={set('serial')} />}
          </Field>
          <Field label={t('installedOn')} error={fieldError(save.error, 'installedOn')}>
            {(p) => <Input {...p} type="date" value={f.installedOn} onChange={set('installedOn')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
        if (i.status === 'applied') toast.show(t('imported', { n: i.appliedCount }));
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
            <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>
              {t('applyReadings', { n: checked.rowCount })}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={check.error ?? apply.error} />
        {checked ? null : (
          <FileUpload purpose="data_import" label={t('chooseSheet')} disabled={check.isPending} onUploaded={(f) => check.mutateAsync(f).then(() => undefined)} />
        )}
        {checked ? (
          <p>
            {t('checkResult', { status: label(checked.status), rows: checked.rowCount, problems: checked.errorCount })}
          </p>
        ) : null}
        {checked && checked.errors.length ? (
          <DataTable
            rows={checked.errors}
            rowKey={(e) => `${e.line}-${e.field}`}
            columns={[
              { key: 'l', header: t('col.line'), cell: (e) => e.line },
              { key: 'f', header: t('col.column'), cell: (e) => e.field },
              { key: 'c', header: t('col.problem'), cell: (e) => label(e.code) },
            ]}
          />
        ) : null}
      </div>
    </Dialog>
  );
}

/** The compound's meters (ADR 0066). */
export default function MetersPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const [kind, setKind] = useState<Kind>('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const filters = { kind, active: 'true' as const };
  const list = useCursorList(keys.meters(filters), (c) => fetchers.meters(filters, c), { enabled: can('energy.read') });
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
            <>
              <Button onClick={() => setImporting(true)}>{t('importReadings')}</Button>
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t('newMeter')}
              </Button>
            </>
          ) : null
        }
      />
      <div className="toolbar">
        <Segmented<Kind>
          label={t('kind')}
          value={kind}
          onChange={setKind}
          options={[{ value: '', label: c('all') }, ...KINDS.map((k) => ({ value: k as Kind, label: label(k) }))]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Meter>
            rows={list.rows}
            rowKey={(m) => m.id}
            empty={t('empty')}
            columns={[
              {
                key: 'c',
                header: t('col.code'),
                cell: (m) => (
                  <Link className="table__link" href={`/meters/${m.id}`}>
                    {m.code}
                  </Link>
                ),
              },
              { key: 'k', header: t('col.kind'), cell: (m) => `${label(m.kind)} (${m.unit})` },
              { key: 'm', header: t('col.mode'), cell: (m) => label(m.mode) },
              { key: 'w', header: t('col.where'), cell: (m) => (m.unitId ? t('placeUnit') : t('placeArea')) },
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
