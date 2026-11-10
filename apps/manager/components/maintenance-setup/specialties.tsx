'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Specialty } from '@/lib/queries';
import ar from '@/messages/ar/ms-specialties';
import en from '@/messages/en/ms-specialties';
import { NameFields, namesReady, NO_NAMES, useNameOf } from './names';

function SpecialtyDialog({ specialty, onClose }: { specialty: Specialty | null; onClose: () => void }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const nameOf = useNameOf();
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
        toast.show(specialty ? t('saved', { name: nameOf(saved) }) : t('added', { name: nameOf(saved) }));
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
      title={specialty ? t('editTitle', { name: nameOf(specialty) }) : t('newTitle')}
      description={specialty ? undefined : t('newDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {specialty ? (retiring ? t('saveAndRetire') : common('save')) : t('addSpecialty')}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!specialty} example="hvac" />
        {specialty ? (
          <Checkbox
            label={t('inUse')}
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
  const t = useT(en, ar);
  const common = useCommonT();
  const specialties = useQuery({ queryKey: keys.specialties, queryFn: fetchers.specialties });
  const [open, setOpen] = useState<Specialty | 'new' | null>(null);
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen('new')}>
          {t('newSpecialty')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={specialties}>
          <DataTable<Specialty>
            rows={specialties.data?.data}
            rowKey={(s) => s.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              {
                key: 'name',
                header: t('col.specialty'),
                cell: (s) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary" dir="ltr" lang="en">
                      {s.nameEn}
                    </span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {s.nameAr}
                    </span>
                    {!s.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'key', header: t('col.code'), cell: (s) => <span className="t-mono">{s.key}</span> },
              {
                key: 'actions',
                header: <span className="visually-hidden">{common('actions')}</span>,
                className: 'table__actions',
                cell: (s) => (
                  <Button size="sm" onClick={() => setOpen(s)}>
                    {common('edit')}
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
