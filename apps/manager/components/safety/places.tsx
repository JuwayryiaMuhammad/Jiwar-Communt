'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, Input, StatusBadge, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { nameIn } from '@/components/security/logic';
import { api } from '@/lib/api';
import { fetchers, keys, type ManagedPlace } from '@/lib/queries';
import ar from '@/messages/ar/sec-places';
import en from '@/messages/en/sec-places';

function PlaceDialog({ place, onClose }: { place: ManagedPlace | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const { locale } = useLocale();
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
        toast.show(t(place ? 'saved' : 'added', { name: nameIn(p, locale) }));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={place ? t('editTitle', { name: nameIn(place, locale) }) : t('newPlace')}
      description={place?.key ? t('defaultPlaceNote') : undefined}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!nameEn.trim() || !nameAr.trim()}>
            {place ? c('save') : t('addPlace')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} autoFocus dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <Field label={t('order')} hint={t('orderHint')} error={fieldError(save.error, 'position')}>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const places = useQuery({ queryKey: keys.places, queryFn: fetchers.places });
  const [editing, setEditing] = useState<ManagedPlace | 'new' | null>(null);
  const toggle = useAction(
    (p: ManagedPlace) =>
      unwrap(api.PATCH('/api/v1/places/{id}', { params: { path: { id: p.id } }, body: { active: !p.active } })),
    {
      invalidate: [keys.places],
      onDone: (p) => toast.show(t(p.active ? 'offeredAgain' : 'retiredToast', { name: nameIn(p, locale) })),
    },
  );
  return (
    <>
      <div className="row">
        <p className="t-secondary" style={{ flex: 1 }}>
          {t('note')}
        </p>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setEditing('new')}>
          {t('newPlace')}
        </Button>
      </div>
      <ErrorAlert error={toggle.error} />
      <Card flush>
        <QueryState query={places}>
          <DataTable<ManagedPlace>
            rows={places.data?.data}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              { key: 'name', header: t('col.place'), cell: (p) => <span className="table__primary">{p.nameEn}</span> },
              { key: 'ar', header: t('col.arabic'), cell: (p) => <span dir="rtl">{p.nameAr}</span> },
              { key: 'order', header: t('order'), cell: (p) => <span className="t-num">{f.number(p.position)}</span> },
              {
                key: 'status',
                header: c('status'),
                cell: (p) => <StatusBadge status={p.active ? 'active' : 'inactive'} />,
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (p) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setEditing(p)}>
                      {c('edit')}
                    </Button>
                    <Button size="sm" loading={toggle.isPending && toggle.variables?.id === p.id} onClick={() => toggle.mutate(p)}>
                      {p.active ? t('retire') : t('restore')}
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
