'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Checklist, type ChecklistSummary } from '@/lib/queries';
import ar from '@/messages/ar/ms-checklists';
import en from '@/messages/en/ms-checklists';
import { NameFields, namesReady, NO_NAMES, useNameOf } from './names';

type Item = Checklist['items'][number];
type Draft = {
  kind: Item['kind'];
  labelEn: string;
  labelAr: string;
  required: boolean;
  metricKey: string;
  unit: string;
  minValue: string;
  maxValue: string;
};

const blank = (): Draft => ({ kind: 'check', labelEn: '', labelAr: '', required: true, metricKey: '', unit: '', minValue: '', maxValue: '' });

const toBody = (d: Draft) => ({
  kind: d.kind,
  labelEn: d.labelEn.trim(),
  labelAr: d.labelAr.trim(),
  required: d.required,
  ...(d.kind === 'reading'
    ? {
        metricKey: d.metricKey.trim(),
        ...(d.unit.trim() ? { unit: d.unit.trim() } : {}),
        ...(d.minValue.trim() ? { minValue: d.minValue.trim() } : {}),
        ...(d.maxValue.trim() ? { maxValue: d.maxValue.trim() } : {}),
      }
    : {}),
});

function ItemsEditor({ items, onChange, error }: { items: Draft[]; onChange: (items: Draft[]) => void; error: unknown }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const label = useLabel();
  const set = (i: number, patch: Partial<Draft>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="stack stack--sm">
      {items.map((d, i) => (
        <div key={i} className="form__row">
          <Field label={t('itemN', { n: i + 1 })} error={fieldError(error, `items.${i}.kind`)}>
            {(p) => (
              <Select {...p} value={d.kind} onChange={(e) => set(i, { kind: e.target.value as Item['kind'] })}>
                {['check', 'reading', 'photo', 'text'].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('labelEn')} error={fieldError(error, `items.${i}.labelEn`)}>
            {(p) => <Input {...p} dir="ltr" value={d.labelEn} onChange={(e) => set(i, { labelEn: e.target.value })} />}
          </Field>
          <Field label={t('labelAr')} error={fieldError(error, `items.${i}.labelAr`)}>
            {(p) => <Input {...p} dir="rtl" lang="ar" value={d.labelAr} onChange={(e) => set(i, { labelAr: e.target.value })} />}
          </Field>
          {d.kind === 'reading' ? (
            <>
              <Field label={t('metric')} error={fieldError(error, `items.${i}.metricKey`)}>
                {(p) => <Input {...p} value={d.metricKey} onChange={(e) => set(i, { metricKey: e.target.value })} />}
              </Field>
              <Field label={t('unit')}>{(p) => <Input {...p} value={d.unit} onChange={(e) => set(i, { unit: e.target.value })} />}</Field>
              <Field label={t('min')}>{(p) => <Input {...p} value={d.minValue} onChange={(e) => set(i, { minValue: e.target.value })} />}</Field>
              <Field label={t('max')} error={fieldError(error, `items.${i}.maxValue`)}>
                {(p) => <Input {...p} value={d.maxValue} onChange={(e) => set(i, { maxValue: e.target.value })} />}
              </Field>
            </>
          ) : null}
          <Checkbox label={t('required')} checked={d.required} onChange={(e) => set(i, { required: e.target.checked })} />
          <Button size="sm" icon={<Trash2 aria-hidden />} onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={items.length === 1}>
            <span className="visually-hidden">{common('remove')}</span>
          </Button>
        </div>
      ))}
      <Button size="sm" icon={<Plus aria-hidden />} onClick={() => onChange([...items, blank()])}>
        {t('addItem')}
      </Button>
    </div>
  );
}

function ChecklistDialog({ checklist, onClose }: { checklist: ChecklistSummary | null; onClose: () => void }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const nameOf = useNameOf();
  const toast = useToast();
  const full = useQuery({
    queryKey: keys.checklist(checklist?.id ?? ''),
    queryFn: () => fetchers.checklist(checklist!.id),
    enabled: checklist !== null,
  });
  const [names, setNames] = useState(checklist ? { key: checklist.key, nameEn: checklist.nameEn, nameAr: checklist.nameAr } : NO_NAMES);
  const [purpose, setPurpose] = useState<ChecklistSummary['purpose']>(checklist?.purpose ?? 'any');
  const [requireScan, setRequireScan] = useState(checklist?.requireScan ?? false);
  const [items, setItems] = useState<Draft[] | null>(checklist ? null : [blank()]);
  const loaded =
    items ??
    full.data?.items.map((i) => ({
      kind: i.kind,
      labelEn: i.labelEn,
      labelAr: i.labelAr,
      required: i.required,
      metricKey: i.metricKey ?? '',
      unit: i.unit ?? '',
      minValue: i.minValue ?? '',
      maxValue: i.maxValue ?? '',
    })) ??
    [];
  const save = useAction(
    async () => {
      if (!checklist)
        return unwrap(
          api.POST('/api/v1/maintenance/checklists', {
            body: { key: names.key, nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim(), purpose, requireScan, items: loaded.map(toBody) },
          }),
        );
      await unwrap(
        api.PATCH('/api/v1/maintenance/checklists/{id}', {
          params: { path: { id: checklist.id } },
          body: { nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim(), requireScan },
        }),
      );
      return items
        ? unwrap(api.PUT('/api/v1/maintenance/checklists/{id}/items', { params: { path: { id: checklist.id } }, body: { items: items.map(toBody) } }))
        : unwrap(api.GET('/api/v1/maintenance/checklists/{id}', { params: { path: { id: checklist.id } } }));
    },
    {
      invalidate: [keys.checklists],
      onDone: (c) => {
        toast.show(items && checklist ? t('savedVersion', { name: nameOf(c), version: c.version }) : t('saved', { name: nameOf(c) }));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={checklist ? t('editTitle', { name: nameOf(checklist) }) : t('newTitle')}
      description={checklist ? t('editDescription') : undefined}
      onSubmit={() => namesReady(names, !checklist) && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!namesReady(names, !checklist)}>
            {common('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!checklist} example="pump_service" />
        <div className="form__row">
          {checklist ? null : (
            <Field label={t('for')} error={fieldError(save.error, 'purpose')}>
              {(p) => (
                <Select {...p} value={purpose} onChange={(e) => setPurpose(e.target.value as ChecklistSummary['purpose'])}>
                  <option value="any">{t('purpose.any')}</option>
                  <option value="pm">{t('purpose.pm')}</option>
                  <option value="inspection">{t('purpose.inspection')}</option>
                </Select>
              )}
            </Field>
          )}
          <Checkbox label={t('requireScan')} checked={requireScan} onChange={(e) => setRequireScan(e.target.checked)} />
        </div>
        <ItemsEditor items={loaded} onChange={setItems} error={save.error} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The compound's checklists (ADR 0064). */
export function Checklists() {
  const t = useT(en, ar);
  const common = useCommonT();
  const nameOf = useNameOf();
  const list = useQuery({ queryKey: keys.checklists, queryFn: fetchers.checklists });
  const [open, setOpen] = useState<ChecklistSummary | 'new' | null>(null);
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
          {t('newChecklist')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ChecklistSummary>
            rows={list.data?.data}
            rowKey={(c) => c.id}
            empty={t('empty')}
            columns={[
              {
                key: 'n',
                header: t('col.checklist'),
                cell: (c) => (
                  <span className="row" style={{ gap: 8 }}>
                    <span className="table__primary">{nameOf(c)}</span>
                    {!c.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'p', header: t('col.for'), cell: (c) => (c.purpose === 'any' ? t('purposeShort.any') : t(`purpose.${c.purpose}`)) },
              { key: 'v', header: t('col.version'), cell: (c) => <span className="t-num">{c.version}</span> },
              { key: 's', header: t('col.scan'), cell: (c) => (c.requireScan ? t('scanRequired') : '—') },
              {
                key: 'x',
                header: <span className="visually-hidden">{common('actions')}</span>,
                className: 'table__actions',
                cell: (c) => (
                  <Button size="sm" onClick={() => setOpen(c)}>
                    {common('edit')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {open ? <ChecklistDialog checklist={open === 'new' ? null : open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
