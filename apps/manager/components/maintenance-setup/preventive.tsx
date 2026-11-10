'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Category, type PreventiveService } from '@/lib/queries';
import ar from '@/messages/ar/ms-preventive';
import en from '@/messages/en/ms-preventive';
import { NameFields, namesReady, NO_NAMES, useNameOf } from './names';

function ServiceDialog({
  service,
  categories,
  onClose,
}: {
  service: PreventiveService | null;
  categories: Category[];
  onClose: () => void;
}) {
  const t = useT(en, ar);
  const common = useCommonT();
  const nameOf = useNameOf();
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
        toast.show(service ? t('saved', { name: nameOf(saved) }) : t('added', { name: nameOf(saved) }));
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
      title={service ? t('editTitle', { name: nameOf(service) }) : t('newTitle')}
      description={service ? undefined : t('newDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {service ? common('save') : t('addService')}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!service} example="water_heater" />
        <div className="form__row">
          <Field label={t('category')} hint={t('categoryHint')} error={fieldError(save.error, 'categoryId')}>
            {(p) => (
              <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{common('select')}</option>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.active ? nameOf(c) : t('retiredSuffix', { name: nameOf(c) })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('position')}
            hint={service ? t('positionHint') : t('positionHintNew')}
            error={fieldError(save.error, 'position')}
          >
            {(p) => <Input {...p} type="number" min={0} max={1000} value={position} onChange={(e) => setPosition(e.target.value)} />}
          </Field>
        </div>
        {service ? (
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

/** The check-ups residents can book (ADR 0038), in the order they see them. */
export function PreventiveServices() {
  const t = useT(en, ar);
  const common = useCommonT();
  const nameOf = useNameOf();
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
          {t('newService')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={services}>
          <DataTable<PreventiveService>
            rows={rows}
            rowKey={(s) => s.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              { key: 'position', header: t('col.position'), width: 90, cell: (s) => <span className="t-num">{s.position}</span> },
              {
                key: 'name',
                header: t('col.service'),
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
                key: 'category',
                header: t('col.category'),
                cell: (s) => {
                  const c = byId.get(s.categoryId);
                  return c ? (
                    <span className="row" style={{ gap: 6 }}>
                      {nameOf(c)}
                      {!c.active ? <Badge tone="terracotta">{t('retiredCategory')}</Badge> : null}
                    </span>
                  ) : (
                    '—'
                  );
                },
              },
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
      {open ? (
        <ServiceDialog service={open === 'new' ? null : open} categories={categories.data?.data ?? []} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}
