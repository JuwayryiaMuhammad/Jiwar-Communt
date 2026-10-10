'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Category, type PreventiveService } from '@/lib/queries';
import { NameFields, namesReady, NO_NAMES } from './names';

function ServiceDialog({
  service,
  categories,
  onClose,
}: {
  service: PreventiveService | null;
  categories: Category[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [names, setNames] = useState(service ? { key: service.key, nameEn: service.nameEn, nameAr: service.nameAr } : NO_NAMES);
  const [categoryId, setCategoryId] = useState(service?.categoryId ?? '');
  const [position, setPosition] = useState(service ? String(service.position) : '');
  const [active, setActive] = useState(service?.active ?? true);
  const body = {
    nameEn: names.nameEn.trim(),
    nameAr: names.nameAr.trim(),
    categoryId,
    ...(position.trim() !== '' ? { position: Number(position) } : {}),
  };
  const save = useAction(
    () =>
      service
        ? unwrap(api.PATCH('/api/v1/maintenance/preventive-services/{id}', { params: { path: { id: service.id } }, body: { ...body, active } }))
        : unwrap(api.POST('/api/v1/maintenance/preventive-services', { body: { ...body, key: names.key } })),
    {
      invalidate: [keys.preventiveServices],
      onDone: (saved) => {
        toast.show(service ? `${saved.nameEn} is saved.` : `${saved.nameEn} is added.`);
        onClose();
      },
    },
  );
  const ready = namesReady(names, !service) && categoryId !== '' && (service === null || position.trim() !== '');
  // A retired category stays listed while the service still points at it.
  const usable = categories.filter((c) => c.active || c.id === service?.categoryId);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={service ? `Edit ${service.nameEn}` : 'New preventive service'}
      description={service ? undefined : 'A check-up residents can book, e.g. a water heater service. They pick it from a list and choose a time.'}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {service ? 'Save' : 'Add service'}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!service} example="water_heater" />
        <div className="form__row">
          <Field label="Category" hint="Its technicians do the check-up, and its SLA targets apply." error={fieldError(save.error, 'categoryId')}>
            {(p) => (
              <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Select…</option>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nameEn}
                    {c.active ? '' : ' (retired)'}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Position"
            hint={service ? 'The order residents see, lowest first (0 to 1000).' : 'The order residents see, lowest first (0 to 1000). Empty: after the others.'}
            error={fieldError(save.error, 'position')}
          >
            {(p) => <Input {...p} type="number" min={0} max={1000} value={position} onChange={(e) => setPosition(e.target.value)} />}
          </Field>
        </div>
        {service ? (
          <Checkbox
            label="In use. Unticked retires it: no new request for it; the bookings it has stay"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The check-ups residents can book (ADR 0038), in the order they see them. */
export function PreventiveServices() {
  const services = useQuery({ queryKey: keys.preventiveServices, queryFn: fetchers.preventiveServices });
  const categories = useQuery({ queryKey: keys.categories, queryFn: fetchers.categories });
  const [open, setOpen] = useState<PreventiveService | 'new' | null>(null);
  const byId = new Map((categories.data?.data ?? []).map((c) => [c.id, c]));
  const rows = services.data ? [...services.data.data].sort((a, b) => a.position - b.position || a.nameEn.localeCompare(b.nameEn)) : undefined;
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
          New service
        </Button>
      </div>
      <Card flush>
        <QueryState query={services}>
          <DataTable<PreventiveService>
            rows={rows}
            rowKey={(s) => s.id}
            empty="No preventive service yet"
            emptyHint="Residents see no check-up to book until you add one."
            columns={[
              { key: 'position', header: 'Position', width: 90, cell: (s) => <span className="t-num">{s.position}</span> },
              {
                key: 'name',
                header: 'Service',
                cell: (s) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{s.nameEn}</span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {s.nameAr}
                    </span>
                    {!s.active ? <Badge tone="beige">Retired</Badge> : null}
                  </span>
                ),
              },
              { key: 'key', header: 'Code', cell: (s) => <span className="t-mono">{s.key}</span> },
              {
                key: 'category',
                header: 'Category',
                cell: (s) => {
                  const c = byId.get(s.categoryId);
                  return c ? (
                    <span className="row" style={{ gap: 6 }}>
                      {c.nameEn}
                      {!c.active ? <Badge tone="terracotta">Retired category</Badge> : null}
                    </span>
                  ) : (
                    '—'
                  );
                },
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (s) => (
                  <Button size="sm" onClick={() => setOpen(s)}>
                    Edit
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {open ? (
        <ServiceDialog service={open === 'new' ? null : open} categories={categories.data?.data ?? []} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}
