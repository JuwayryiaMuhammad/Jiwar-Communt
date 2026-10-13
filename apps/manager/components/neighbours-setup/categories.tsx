'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { NameFields, namesReady, NO_NAMES, type Names } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { fetchers, keys, type ComplaintCategory } from '@/lib/queries';

const SAVED = { invalidate: [keys.complaintCategories, keys.complaintCategoryOptions] };

function CategoryDialog({ category, onClose }: { category: ComplaintCategory | null; onClose: () => void }) {
  const toast = useToast();
  const [names, setNames] = useState<Names>(category ? { key: category.key, nameEn: category.nameEn, nameAr: category.nameAr } : NO_NAMES);
  const save = useAction(
    () =>
      category
        ? unwrap(
            api.PATCH('/api/v1/neighbours/complaint-categories/{id}', {
              params: { path: { id: category.id } },
              body: { nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim() },
            }),
          )
        : unwrap(
            api.POST('/api/v1/neighbours/complaint-categories', {
              body: { key: names.key, nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim() },
            }),
          ),
    {
      ...SAVED,
      onDone: (saved) => {
        toast.show(`${saved.nameEn} is saved.`);
        onClose();
      },
    },
  );
  const ready = namesReady(names, !category);

  return (
    <Dialog
      open
      onClose={onClose}
      title={category ? `Rename ${category.nameEn}` : 'New category'}
      description="What a resident picks when they complain about another unit. The unit complained about is told the category, and nothing else of the complaint."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!category} example="noise" />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

type Open = { category: ComplaintCategory | null } | null;

/**
 * The compound's complaint categories (ADR 0042): a closed list of its own.
 * A retired category is offered to nobody and stays on the complaints that
 * used it; it can be restored.
 */
export function ComplaintCategories() {
  const toast = useToast();
  const categories = useQuery({ queryKey: keys.complaintCategories, queryFn: fetchers.complaintCategories });
  const [open, setOpen] = useState<Open>(null);
  const setActive = useAction(
    (c: ComplaintCategory) =>
      unwrap(api.PATCH('/api/v1/neighbours/complaint-categories/{id}', { params: { path: { id: c.id } }, body: { active: !c.active } })),
    { ...SAVED, onDone: (saved) => toast.show(saved.active ? `${saved.nameEn} is offered again.` : `${saved.nameEn} is retired.`) },
  );

  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ category: null })}>
          New category
        </Button>
      </div>
      <ErrorAlert error={setActive.error} />
      <Card flush>
        <QueryState query={categories}>
          <DataTable<ComplaintCategory>
            rows={categories.data?.data}
            rowKey={(c) => c.id}
            empty="No category yet"
            emptyHint="Residents cannot file a complaint until there is one."
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
              { key: 'key', header: 'Code', cell: (c) => <span className="t-mono">{c.key}</span> },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (c) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setOpen({ category: c })}>
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      loading={setActive.isPending && setActive.variables?.id === c.id}
                      title={c.active ? 'No new complaint may use it; it stays on the complaints that did.' : 'Offer it to residents again.'}
                      onClick={() => setActive.mutate(c)}
                    >
                      {c.active ? 'Retire' : 'Restore'}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {/* Remounted per category, so the form starts from the row that was opened. */}
      {open ? <CategoryDialog key={open.category?.id ?? 'new'} category={open.category} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
