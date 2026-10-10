'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Specialty } from '@/lib/queries';
import { NameFields, namesReady, NO_NAMES } from './names';

function SpecialtyDialog({ specialty, onClose }: { specialty: Specialty | null; onClose: () => void }) {
  const toast = useToast();
  const [names, setNames] = useState(specialty ? { key: specialty.key, nameEn: specialty.nameEn, nameAr: specialty.nameAr } : NO_NAMES);
  const [active, setActive] = useState(specialty?.active ?? true);
  const body = { nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim() };
  const save = useAction(
    () =>
      specialty
        ? unwrap(api.PATCH('/api/v1/maintenance/specialties/{id}', { params: { path: { id: specialty.id } }, body: { ...body, active } }))
        : unwrap(api.POST('/api/v1/maintenance/specialties', { body: { ...body, key: names.key } })),
    {
      invalidate: [keys.specialties, keys.categories, keys.technicians],
      onDone: (saved) => {
        toast.show(specialty ? `${saved.nameEn} is saved.` : `${saved.nameEn} is added.`);
        onClose();
      },
    },
  );
  const ready = namesReady(names, !specialty);
  const retiring = specialty?.active === true && !active;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={specialty ? `Edit ${specialty.nameEn}` : 'New specialty'}
      description={specialty ? undefined : 'A skill a technician has and a category needs, e.g. plumbing. Auto-dispatch matches the two.'}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={retiring ? 'danger' : 'primary'} loading={save.isPending} disabled={!ready}>
            {specialty ? (retiring ? 'Save and retire' : 'Save') : 'Add specialty'}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!specialty} example="hvac" />
        {specialty ? (
          <Checkbox
            label="In use. Unticked retires it: it counts for no category and no technician, so auto-dispatch stops matching on it"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The skills auto-dispatch matches technicians and categories on (ADR 0033). */
export function Specialties() {
  const specialties = useQuery({ queryKey: keys.specialties, queryFn: fetchers.specialties });
  const [open, setOpen] = useState<Specialty | 'new' | null>(null);
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
          New specialty
        </Button>
      </div>
      <Card flush>
        <QueryState query={specialties}>
          <DataTable<Specialty>
            rows={specialties.data?.data}
            rowKey={(s) => s.id}
            empty="No specialty yet"
            emptyHint="Add the skills your technicians have, then give them to technicians (Maintenance, Technicians) and to categories."
            columns={[
              {
                key: 'name',
                header: 'Specialty',
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
      {open ? <SpecialtyDialog specialty={open === 'new' ? null : open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
