'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Holiday } from '@/lib/queries';
import ar from '@/messages/ar/fac-places';
import en from '@/messages/en/fac-places';

const iso = (d: Date) => d.toISOString().slice(0, 10);

function NewHolidayDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [day, setDay] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [stopsWorks, setStopsWorks] = useState(true);
  const save = useAction(
    () => unwrap(api.POST('/api/v1/staff/holidays', { body: { day, nameEn, nameAr, stopsWorks } })),
    {
      invalidate: [keys.spacesAll, keys.permitSettings],
      onDone: () => {
        toast.show(t('holidays.added'));
        onClose();
      },
    },
  );
  const ready = day !== '' && nameEn.trim() !== '' && nameAr.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('holidays.add')}
      description={t('holidays.newDescription')}
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
        <Field label={t('holidays.col.day')} error={fieldError(save.error, 'day')}>
          {(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}
        </Field>
        <Field label={t('holidays.nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} dir="ltr" lang="en" value={nameEn} maxLength={80} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('holidays.nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" value={nameAr} maxLength={80} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <Checkbox
          label={t('holidays.stopsWorks')}
          checked={stopsWorks}
          onChange={(e) => setStopsWorks(e.target.checked)}
        />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/**
 * The compound's holiday calendar (ADR 0084). A holiday that stops works is
 * a day off of the permits; bookings and planned work are only flagged.
 */
export default function HolidaysPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('spaces.manage');
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(new Date(Date.now() + 365 * 24 * 3_600_000)));
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: keys.holidays(from, to), queryFn: () => fetchers.holidays(from, to), enabled: allowed });
  const toggle = useAction(
    (h: Holiday) =>
      unwrap(api.PATCH('/api/v1/staff/holidays/{id}', { params: { path: { id: h.id } }, body: { stopsWorks: !h.stopsWorks } })),
    { invalidate: [keys.spacesAll, keys.permitSettings], onDone: () => toast.show(c('saved')) },
  );
  const remove = useAction(
    (h: Holiday) => unwrap(api.DELETE('/api/v1/staff/holidays/{id}', { params: { path: { id: h.id } } })),
    { invalidate: [keys.spacesAll, keys.permitSettings], onDone: () => toast.show(t('holidays.removed')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('holidays.title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('holidays.title')}
        description={t('holidays.description')}
      />
      <div className="toolbar">
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')} hint={t('holidays.toHint')}>
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          {t('holidays.add')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Holiday>
            rows={list.data?.data ?? []}
            rowKey={(h) => h.id}
            empty={t('holidays.empty')}
            columns={[
              { key: 'day', header: t('holidays.col.day'), cell: (h) => <span className="t-num">{f.day(h.day)}</span> },
              { key: 'name', header: t('holidays.col.name'), cell: (h) => `${h.nameEn} · ${h.nameAr}` },
              {
                key: 'works',
                header: t('holidays.col.works'),
                cell: (h) => (h.stopsWorks ? <Badge tone="terracotta">{t('holidays.stop')}</Badge> : <Badge tone="beige">{t('holidays.goOn')}</Badge>),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (h) => (
                  <>
                    <Button size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(h)}>
                      {h.stopsWorks ? t('holidays.letWorksGoOn') : t('holidays.stopWorks')}
                    </Button>
                    <Button size="sm" variant="text" loading={remove.isPending} onClick={() => remove.mutate(h)}>
                      {c('remove')}
                    </Button>
                  </>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <ErrorAlert error={toggle.error ?? remove.error} />
      {adding ? <NewHolidayDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
