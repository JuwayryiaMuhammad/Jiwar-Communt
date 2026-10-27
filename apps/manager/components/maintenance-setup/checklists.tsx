'use client';

import { fieldError, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Checklist, type ChecklistSummary } from '@/lib/queries';
import { NameFields, namesReady, NO_NAMES } from './names';

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
  const set = (i: number, patch: Partial<Draft>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="stack stack--sm">
      {items.map((d, i) => (
        <div key={i} className="form__row">
          <Field label={`Item ${i + 1}`} error={fieldError(error, `items.${i}.kind`)}>
            {(p) => (
              <Select {...p} value={d.kind} onChange={(e) => set(i, { kind: e.target.value as Item['kind'] })}>
                {['check', 'reading', 'photo', 'text'].map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Label (English)" error={fieldError(error, `items.${i}.labelEn`)}>
            {(p) => <Input {...p} value={d.labelEn} onChange={(e) => set(i, { labelEn: e.target.value })} />}
          </Field>
          <Field label="Label (Arabic)" error={fieldError(error, `items.${i}.labelAr`)}>
            {(p) => <Input {...p} dir="rtl" lang="ar" value={d.labelAr} onChange={(e) => set(i, { labelAr: e.target.value })} />}
          </Field>
          {d.kind === 'reading' ? (
            <>
              <Field label="Metric" error={fieldError(error, `items.${i}.metricKey`)}>
                {(p) => <Input {...p} value={d.metricKey} onChange={(e) => set(i, { metricKey: e.target.value })} />}
              </Field>
              <Field label="Unit">{(p) => <Input {...p} value={d.unit} onChange={(e) => set(i, { unit: e.target.value })} />}</Field>
              <Field label="Min">{(p) => <Input {...p} value={d.minValue} onChange={(e) => set(i, { minValue: e.target.value })} />}</Field>
              <Field label="Max" error={fieldError(error, `items.${i}.maxValue`)}>
                {(p) => <Input {...p} value={d.maxValue} onChange={(e) => set(i, { maxValue: e.target.value })} />}
              </Field>
            </>
          ) : null}
          <Checkbox label="Required" checked={d.required} onChange={(e) => set(i, { required: e.target.checked })} />
          <Button size="sm" icon={<Trash2 aria-hidden />} onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={items.length === 1}>
            <span className="visually-hidden">Remove</span>
          </Button>
        </div>
      ))}
      <Button size="sm" icon={<Plus aria-hidden />} onClick={() => onChange([...items, blank()])}>
        Add item
      </Button>
    </div>
  );
}

function ChecklistDialog({ checklist, onClose }: { checklist: ChecklistSummary | null; onClose: () => void }) {
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
        toast.show(`${c.nameEn} is saved${items && checklist ? ` (version ${c.version})` : ''}.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={checklist ? `Edit ${checklist.nameEn}` : 'New checklist'}
      description={checklist ? 'Changing the items makes a new version: the checklists already being filled keep theirs.' : undefined}
      onSubmit={() => namesReady(names, !checklist) && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!namesReady(names, !checklist)}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!checklist} example="pump_service" />
        <div className="form__row">
          {checklist ? null : (
            <Field label="For" error={fieldError(save.error, 'purpose')}>
              {(p) => (
                <Select {...p} value={purpose} onChange={(e) => setPurpose(e.target.value as ChecklistSummary['purpose'])}>
                  <option value="any">Planned jobs and inspections</option>
                  <option value="pm">Planned jobs</option>
                  <option value="inspection">Inspections</option>
                </Select>
              )}
            </Field>
          )}
          <Checkbox label="The tag must be scanned before it is submitted" checked={requireScan} onChange={(e) => setRequireScan(e.target.checked)} />
        </div>
        <ItemsEditor items={loaded} onChange={setItems} error={save.error} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The compound's checklists (ADR 0064). */
export function Checklists() {
  const list = useQuery({ queryKey: keys.checklists, queryFn: fetchers.checklists });
  const [open, setOpen] = useState<ChecklistSummary | 'new' | null>(null);
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
          New checklist
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ChecklistSummary>
            rows={list.data?.data}
            rowKey={(c) => c.id}
            empty="No checklist yet"
            columns={[
              {
                key: 'n',
                header: 'Checklist',
                cell: (c) => (
                  <span className="row" style={{ gap: 8 }}>
                    <span className="table__primary">{c.nameEn}</span>
                    {!c.active ? <Badge tone="beige">Retired</Badge> : null}
                  </span>
                ),
              },
              { key: 'p', header: 'For', cell: (c) => ({ pm: 'Planned jobs', inspection: 'Inspections', any: 'Both' })[c.purpose] },
              { key: 'v', header: 'Version', cell: (c) => <span className="t-num">{c.version}</span> },
              { key: 's', header: 'Scan', cell: (c) => (c.requireScan ? 'Required' : '—') },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (c) => (
                  <Button size="sm" onClick={() => setOpen(c)}>
                    Edit
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
