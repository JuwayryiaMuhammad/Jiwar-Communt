'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { PriorityBadge } from '@/components/maintenance/sla';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Category, type Specialty, type TicketPriority } from '@/lib/queries';
import ar from '@/messages/ar/ms-categories';
import arCommon from '@/messages/ar/ms-common';
import en from '@/messages/en/ms-categories';
import enCommon from '@/messages/en/ms-common';
import { formatMinutes } from './format';
import { NameFields, namesReady, NO_NAMES, useNameOf } from './names';
import { SlaTargetsDialog } from './sla-targets-dialog';

function CategoryDialog({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const label = useLabel();
  const nameOf = useNameOf();
  const toast = useToast();
  const [names, setNames] = useState(category ? { key: category.key, nameEn: category.nameEn, nameAr: category.nameAr } : NO_NAMES);
  const [priority, setPriority] = useState<TicketPriority>(category?.defaultPriority ?? 'normal');
  const [commonArea, setCommonArea] = useState(category?.commonAreaAllowed ?? true);
  const [active, setActive] = useState(category?.active ?? true);
  const body = {
    nameEn: names.nameEn.trim(),
    nameAr: names.nameAr.trim(),
    defaultPriority: priority,
    commonAreaAllowed: commonArea,
  };
  const save = useAction(
    () =>
      category
        ? unwrap(api.PATCH('/api/v1/maintenance/categories/{id}', { params: { path: { id: category.id } }, body: { ...body, active } }))
        : unwrap(api.POST('/api/v1/maintenance/categories', { body: { ...body, key: names.key } })),
    {
      invalidate: [keys.categories, keys.ticketCategories],
      onDone: (saved) => {
        toast.show(category ? t('saved', { name: nameOf(saved) }) : t('added', { name: nameOf(saved) }));
        onClose();
      },
    },
  );
  const ready = namesReady(names, !category);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={category ? t('editTitle', { name: nameOf(category) }) : t('newTitle')}
      description={category ? undefined : t('newDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {category ? common('save') : t('addCategory')}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!category} example="pool" />
        <Field label={t('defaultPriority')} hint={t('defaultPriorityHint')} error={fieldError(save.error, 'defaultPriority')}>
          {(p) => (
            <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
              <option value="normal">{label('normal')}</option>
              <option value="urgent">{label('urgent')}</option>
              <option value="emergency">{label('emergency')}</option>
            </Select>
          )}
        </Field>
        <Checkbox label={t('commonAreas')} checked={commonArea} onChange={(e) => setCommonArea(e.target.checked)} />
        {category ? (
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

function CategorySpecialtiesDialog({ category, specialties, onClose }: { category: Category; specialties: Specialty[]; onClose: () => void }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const nameOf = useNameOf();
  const toast = useToast();
  const [picked, setPicked] = useState(() => new Set(category.specialtyIds));
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/maintenance/categories/{id}/specialties', {
          params: { path: { id: category.id } },
          body: { specialtyIds: [...picked] },
        }),
      ),
    {
      invalidate: [keys.categories],
      onDone: () => {
        toast.show(t('specialtiesSaved', { name: nameOf(category) }));
        onClose();
      },
    },
  );
  const active = specialties.filter((s) => s.active);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('specialtiesTitle', { name: nameOf(category) })}
      description={t('specialtiesDescription')}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {common('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        {active.length === 0 ? <p className="t-secondary">{t('addSpecialtyFirst')}</p> : null}
        {active.map((s) => (
          <Checkbox
            key={s.id}
            label={nameOf(s)}
            checked={picked.has(s.id)}
            onChange={(e) =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (e.target.checked) next.add(s.id);
                else next.delete(s.id);
                return next;
              })
            }
          />
        ))}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

type Open = { kind: 'new' } | { kind: 'edit' | 'specialties' | 'sla'; category: Category } | null;

/** What residents may report, who can fix it, and how fast (ADR 0032-0034). */
export function Categories({ view }: { view: 'categories' | 'sla' }) {
  const t = useT(en, ar);
  const duration = useT(enCommon, arCommon);
  const common = useCommonT();
  const label = useLabel();
  const nameOf = useNameOf();
  const { can } = usePermissions();
  const categories = useQuery({ queryKey: keys.categories, queryFn: fetchers.categories });
  // The specialties list reads with either permission (a dispatcher's, or the
  // one that writes them); a role with neither sees counts, not names.
  const readsSpecialties = can('tickets.dispatch') || can('maintenance.manage');
  const specialties = useQuery({ queryKey: keys.specialties, queryFn: fetchers.specialties, enabled: readsSpecialties, retry: false });
  const [open, setOpen] = useState<Open>(null);
  const names = new Map((specialties.data?.data ?? []).map((s) => [s.id, s]));
  const target = (c: Category, p: TicketPriority) =>
    `${formatMinutes(c.slaTargets[p].responseMinutes, duration)} / ${formatMinutes(c.slaTargets[p].resolutionMinutes, duration)}`;

  return (
    <>
      {view === 'categories' ? (
        <div className="toolbar">
          <span className="spacer" />
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ kind: 'new' })}>
            {t('newCategoryButton')}
          </Button>
        </div>
      ) : null}
      <Card flush>
        <QueryState query={categories}>
          <DataTable<Category>
            rows={categories.data?.data}
            rowKey={(c) => c.id}
            empty={t('empty')}
            columns={[
              {
                key: 'name',
                header: t('col.category'),
                cell: (c) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary" dir="ltr" lang="en">
                      {c.nameEn}
                    </span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {c.nameAr}
                    </span>
                    {!c.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              ...(view === 'categories'
                ? [
                    { key: 'key', header: t('col.code'), cell: (c: Category) => <span className="t-mono">{c.key}</span> },
                    { key: 'priority', header: t('col.priority'), cell: (c: Category) => <PriorityBadge priority={c.defaultPriority} /> },
                    {
                      key: 'where',
                      header: t('col.where'),
                      cell: (c: Category) => (c.commonAreaAllowed ? t('whereBoth') : t('whereUnits')),
                    },
                    {
                      key: 'specialties',
                      header: t('col.specialties'),
                      cell: (c: Category) =>
                        c.specialtyIds.length === 0 ? (
                          <Badge tone="terracotta">{t('noSpecialty')}</Badge>
                        ) : specialties.data ? (
                          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            {c.specialtyIds.map((id) => (
                              <Badge key={id} plain>
                                {nameOf(names.get(id) ?? { nameEn: t('retiredSpecialty'), nameAr: t('retiredSpecialty') })}
                              </Badge>
                            ))}
                          </span>
                        ) : (
                          `${c.specialtyIds.length}`
                        ),
                    },
                  ]
                : (['emergency', 'urgent', 'normal'] as const).map((p) => ({
                    key: p,
                    header: <span title={t('col.responseResolution')}>{label(p)}</span>,
                    cell: (c: Category) => <span style={{ whiteSpace: 'nowrap' }}>{target(c, p)}</span>,
                  }))),
              {
                key: 'actions',
                header: <span className="visually-hidden">{common('actions')}</span>,
                className: 'table__actions',
                cell: (c) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    {view === 'categories' ? (
                      <>
                        <Button size="sm" onClick={() => setOpen({ kind: 'edit', category: c })}>
                          {common('edit')}
                        </Button>
                        {readsSpecialties ? (
                          <Button size="sm" onClick={() => setOpen({ kind: 'specialties', category: c })}>
                            {t('specialtiesButton')}
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <Button size="sm" onClick={() => setOpen({ kind: 'sla', category: c })}>
                        {t('changeTargets')}
                      </Button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {open?.kind === 'new' ? <CategoryDialog category={null} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'edit' ? <CategoryDialog category={open.category} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'specialties' ? (
        <CategorySpecialtiesDialog category={open.category} specialties={specialties.data?.data ?? []} onClose={() => setOpen(null)} />
      ) : null}
      {open?.kind === 'sla' ? <SlaTargetsDialog category={open.category} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
