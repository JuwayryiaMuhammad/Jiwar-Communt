'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, Input, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type ManagedPlace } from '@/lib/queries';

function PlaceDialog({ place, onClose }: { place: ManagedPlace | null; onClose: () => void }) {
  const toast = useToast();
  const [nameEn, setNameEn] = useState(place?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(place?.nameAr ?? '');
  const [position, setPosition] = useState(String(place?.position ?? 0));
  const body = { nameEn: nameEn.trim(), nameAr: nameAr.trim(), position: Number(position) };
  const save = useAction(
    () =>
      place
        ? unwrap(api.PATCH('/api/v1/places/{id}', { params: { path: { id: place.id } }, body }))
        : unwrap(api.POST('/api/v1/places', { body })),
    {
      invalidate: [keys.places],
      onDone: (p) => {
        toast.show(place ? `${p.nameEn} saved.` : `${p.nameEn} added.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={place ? `Edit ${place.nameEn}` : 'New place'}
      description={place?.key ? 'A default place: the app names it in its own words; your names show on this dashboard.' : undefined}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!nameEn.trim() || !nameAr.trim()}>
            {place ? 'Save' : 'Add place'}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} autoFocus value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <Field label="Order" hint="Lower first (0–1000)." error={fieldError(save.error, 'position')}>
          {(p) => <Input {...p} type="number" min={0} max={1000} value={position} onChange={(e) => setPosition(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/**
 * The compound's places (ADR 0047): where residents ask security to meet
 * them, walk with them or look. Retired places are offered no more; a
 * place is never deleted, requests keep it.
 */
export function Places() {
  const toast = useToast();
  const places = useQuery({ queryKey: keys.places, queryFn: fetchers.places });
  const [editing, setEditing] = useState<ManagedPlace | 'new' | null>(null);
  const toggle = useAction(
    (p: ManagedPlace) =>
      unwrap(api.PATCH('/api/v1/places/{id}', { params: { path: { id: p.id } }, body: { active: !p.active } })),
    {
      invalidate: [keys.places],
      onDone: (p) => toast.show(p.active ? `${p.nameEn} is offered again.` : `${p.nameEn} is retired.`),
    },
  );
  return (
    <>
      <div className="row">
        <p className="t-secondary" style={{ flex: 1 }}>
          Offered to residents for accessibility help, escorts and suspicious-activity reports.
        </p>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setEditing('new')}>
          New place
        </Button>
      </div>
      <ErrorAlert error={toggle.error} />
      <Card flush>
        <QueryState query={places}>
          <DataTable<ManagedPlace>
            rows={places.data?.data}
            rowKey={(p) => p.id}
            empty="No places"
            columns={[
              { key: 'name', header: 'Place', cell: (p) => <span className="table__primary">{p.nameEn}</span> },
              { key: 'ar', header: 'Arabic', cell: (p) => <span dir="rtl">{p.nameAr}</span> },
              { key: 'order', header: 'Order', cell: (p) => <span className="t-num">{p.position}</span> },
              {
                key: 'status',
                header: 'Status',
                cell: (p) => <StatusBadge status={p.active ? 'active' : 'inactive'} />,
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (p) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                    <Button size="sm" loading={toggle.isPending && toggle.variables?.id === p.id} onClick={() => toggle.mutate(p)}>
                      {p.active ? 'Retire' : 'Restore'}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {editing ? <PlaceDialog place={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
