'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { NameFields, namesReady, NO_NAMES, type Names } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { fetchers, keys, type ComplaintCategory } from '@/lib/queries';
import ar from '@/messages/ar/neighbours-setup';
import en from '@/messages/en/neighbours-setup';

const SAVED = { invalidate: [keys.complaintCategories, keys.complaintCategoryOptions] };

function CategoryDialog({ category, onClose }: { category: ComplaintCategory | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const { locale } = useLocale();
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
        toast.show(t('categories.saved', { name: locale === 'ar' ? saved.nameAr : saved.nameEn }));
        onClose();
      },
    },
  );
  const ready = namesReady(names, !category);

  return (
    <Dialog
      open
      onClose={onClose}
      title={category ? t('categories.renameTitle', { name: locale === 'ar' ? category.nameAr : category.nameEn }) : t('categories.newTitle')}
      description={t('categories.dialogDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('save')}
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
  const t = useT(en, ar);
  const { locale } = useLocale();
  const toast = useToast();
  const categories = useQuery({ queryKey: keys.complaintCategories, queryFn: fetchers.complaintCategories });
  const [open, setOpen] = useState<Open>(null);
  const setActive = useAction(
    (c: ComplaintCategory) =>
      unwrap(api.PATCH('/api/v1/neighbours/complaint-categories/{id}', { params: { path: { id: c.id } }, body: { active: !c.active } })),
    { ...SAVED, onDone: (saved) => toast.show(t(saved.active ? 'categories.offered' : 'categories.wasRetired', { name: locale === 'ar' ? saved.nameAr : saved.nameEn })) },
  );

  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ category: null })}>
          {t('categories.new')}
        </Button>
      </div>
      <ErrorAlert error={setActive.error} />
      <Card flush>
        <QueryState query={categories}>
          <DataTable<ComplaintCategory>
            rows={categories.data?.data}
            rowKey={(c) => c.id}
            empty={t('categories.empty')}
            emptyHint={t('categories.emptyHint')}
            columns={[
              {
                key: 'name',
                header: t('categories.category'),
                cell: (c) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{c.nameEn}</span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {c.nameAr}
                    </span>
                    {!c.active ? <Badge tone="beige">{t('categories.retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'key', header: t('categories.code'), cell: (c) => <span className="t-mono ltr">{c.key}</span> },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (c) => (
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setOpen({ category: c })}>
                      {t('categories.rename')}
                    </Button>
                    <Button
                      size="sm"
                      loading={setActive.isPending && setActive.variables?.id === c.id}
                      title={c.active ? t('categories.retireHint') : t('categories.restoreHint')}
                      onClick={() => setActive.mutate(c)}
                    >
                      {c.active ? t('categories.retire') : t('categories.restore')}
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
