'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { PriorityBadge } from '@/components/maintenance/sla';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Category, type Specialty, type TicketPriority } from '@/lib/queries';
import { formatMinutes } from './format';
import { NameFields, namesReady, NO_NAMES } from './names';
import { SlaTargetsDialog } from './sla-targets-dialog';

function CategoryDialog({ category, onClose }: { category: Category | null; onClose: () => void }) {
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
        toast.show(category ? `${saved.nameEn} is saved.` : `${saved.nameEn} is added. Set its specialties and SLA targets next.`);
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
      title={category ? `Edit ${category.nameEn}` : 'New category'}
      description={category ? undefined : 'What residents pick when they open a ticket. It starts with the default SLA targets and no specialty.'}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {category ? 'Save' : 'Add category'}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!category} example="pool" />
        <Field label="Default priority" hint="What a new ticket gets unless the reporter or dispatch says otherwise." error={fieldError(save.error, 'defaultPriority')}>
          {(p) => (
            <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
              <option value="normal">Normal</option>
              <option value="urgent">Urgent</option>
              <option value="emergency">Emergency</option>
            </Select>
          )}
        </Field>
        <Checkbox label="May be used for common areas, not only units" checked={commonArea} onChange={(e) => setCommonArea(e.target.checked)} />
        {category ? (
          <Checkbox
            label="In use. Unticked retires it: no new ticket under it; the tickets it has stay as they are"
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
        toast.show(`Specialties of ${category.nameEn} are saved.`);
        onClose();
      },
    },
  );
  const active = specialties.filter((s) => s.active);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Specialties for ${category.nameEn}`}
      description="Auto-dispatch offers a ticket of this category only to a technician with one of these. With none ticked, no technician qualifies and its tickets wait for a dispatcher."
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        {active.length === 0 ? <p className="t-secondary">Add a specialty first, on the Specialties tab.</p> : null}
        {active.map((s) => (
          <Checkbox
            key={s.id}
            label={s.nameEn}
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
  const { can } = usePermissions();
  const categories = useQuery({ queryKey: keys.categories, queryFn: fetchers.categories });
  // The specialties list is a dispatcher's read; a role without it sees counts, not names.
  const specialties = useQuery({ queryKey: keys.specialties, queryFn: fetchers.specialties, enabled: can('tickets.dispatch'), retry: false });
  const [open, setOpen] = useState<Open>(null);
  const names = new Map((specialties.data?.data ?? []).map((s) => [s.id, s]));
  const target = (c: Category, p: TicketPriority) =>
    `${formatMinutes(c.slaTargets[p].responseMinutes)} / ${formatMinutes(c.slaTargets[p].resolutionMinutes)}`;

  return (
    <>
      {view === 'categories' ? (
        <div className="toolbar">
          <span className="spacer" />
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ kind: 'new' })}>
            New category
          </Button>
        </div>
      ) : null}
      <Card flush>
        <QueryState query={categories}>
          <DataTable<Category>
            rows={categories.data?.data}
            rowKey={(c) => c.id}
            empty="No category yet"
            columns={[
              {
                key: 'name',
                header: 'Category',
                cell: (c) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{c.nameEn}</span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {c.nameAr}
                    </span>
                    {!c.active ? <Badge tone="beige">Retired</Badge> : null}
                  </span>
                ),
              },
              ...(view === 'categories'
                ? [
                    { key: 'key', header: 'Code', cell: (c: Category) => <span className="t-mono">{c.key}</span> },
                    { key: 'priority', header: 'Default priority', cell: (c: Category) => <PriorityBadge priority={c.defaultPriority} /> },
                    {
                      key: 'where',
                      header: 'Where',
                      cell: (c: Category) => (c.commonAreaAllowed ? 'Units and common areas' : 'Units only'),
                    },
                    {
                      key: 'specialties',
                      header: 'Specialties',
                      cell: (c: Category) =>
                        c.specialtyIds.length === 0 ? (
                          <Badge tone="terracotta">None: no auto-dispatch</Badge>
                        ) : specialties.data ? (
                          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            {c.specialtyIds.map((id) => (
                              <Badge key={id} plain>
                                {names.get(id)?.nameEn ?? 'Retired specialty'}
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
                    header: <span title="Response / resolution">{p.charAt(0).toUpperCase() + p.slice(1)}</span>,
                    cell: (c: Category) => <span style={{ whiteSpace: 'nowrap' }}>{target(c, p)}</span>,
                  }))),
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (c) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    {view === 'categories' ? (
                      <>
                        <Button size="sm" onClick={() => setOpen({ kind: 'edit', category: c })}>
                          Edit
                        </Button>
                        {can('tickets.dispatch') ? (
                          <Button size="sm" onClick={() => setOpen({ kind: 'specialties', category: c })}>
                            Specialties
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <Button size="sm" onClick={() => setOpen({ kind: 'sla', category: c })}>
                        Change targets
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
