'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Alert, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { filtersFor, VIEWS, type View } from '@/components/neighbours/logic';
import { useWho } from '@/components/neighbours/who';
import { UnitPicker } from '@/components/unit-picker';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Complaint, type ComplaintFilters } from '@/lib/queries';
import ar from '@/messages/ar/complaints';
import en from '@/messages/en/complaints';

/**
 * Complaints between units (ADR 0042), by last activity. A view narrows by
 * status; the selects narrow by category and by the unit complained about.
 * `?unit=` and `?author=` open the inbox already narrowed, from a
 * complaint's side panels. Every filter is applied by the API, so each page
 * is full.
 */
function Inbox() {
  const t = useT(en, ar);
  const cm = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const who = useWho();
  const { can, ready } = usePermissions();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [view, setView] = useState<View>(params.get('unit') || params.get('author') ? 'all' : 'open');
  const [categoryId, setCategoryId] = useState('');
  const [targetUnitId, setTargetUnitId] = useState(params.get('unit') ?? '');
  const [authorId, setAuthorId] = useState(params.get('author') ?? '');
  const allowed = can('neighbours.handle');

  const filters = filtersFor(view, { categoryId, targetUnitId, authorId }) as ComplaintFilters;
  const categories = useQuery({ queryKey: keys.complaintCategoryOptions, queryFn: fetchers.complaintCategoryOptions, enabled: allowed });
  const list = useCursorList(keys.complaints(filters), (c) => fetchers.complaints(filters, c), {
    refetchInterval: 60_000,
    enabled: allowed,
  });
  // What there has been against the unit picked, whatever the view shows.
  const history = useQuery({
    queryKey: keys.unitComplaintHistory(targetUnitId),
    queryFn: () => fetchers.unitComplaintHistory(targetUnitId),
    enabled: allowed && targetUnitId !== '',
  });

  if (ready && !allowed) return <ForbiddenState />;

  // A filter that came with the link leaves the address when it is changed.
  const drop = () => {
    if (params.size) router.replace(pathname, { scroll: false });
  };
  const pickUnit = (id: string) => {
    setTargetUnitId(id);
    drop();
  };
  const author = authorId ? list.rows?.find((c) => c.author.id === authorId)?.author : undefined;
  const h = history.data;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="toolbar">
        <Segmented<View> label={t('viewsLabel')} value={view} onChange={setView} options={VIEWS.map((value) => ({ value, label: t(`view.${value}`) }))} />
        <Field label={cm('category')}>
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t('anyCategory')}</option>
              {(categories.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {locale === 'ar' ? c.nameAr : c.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {can('units.read') ? (
          <Field label={t('againstUnit')}>
            {(p) => <UnitPicker {...p} placeholder={t('anyUnit')} style={{ maxWidth: 220 }} value={targetUnitId} onChange={(e) => pickUnit(e.target.value)} />}
          </Field>
        ) : null}
      </div>
      {targetUnitId || authorId ? (
        <div className="stack stack--sm" style={{ marginBottom: 16 }}>
          {targetUnitId ? (
            <Alert>
              <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <span>
                  {t('againstUnit')} <strong>{h ? who.unit(h.unit) : '…'}</strong>
                  {h
                    ? t('againstHistory', {
                        total: f.number(h.history.total),
                        open: f.number(h.history.open),
                        resolved: f.number(h.history.resolved),
                        dismissed: f.number(h.history.dismissed),
                        unfounded: f.number(h.history.unfounded),
                      })
                    : ''}
                </span>
                <Button size="sm" variant="text" icon={<X aria-hidden />} onClick={() => pickUnit('')}>
                  {t('anyUnit')}
                </Button>
              </span>
            </Alert>
          ) : null}
          {authorId ? (
            <Alert>
              <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <span>
                  {t('filedBy')} <strong>{author ? who.person(author) : t('oneComplainant')}</strong>
                </span>
                <Button
                  size="sm"
                  variant="text"
                  icon={<X aria-hidden />}
                  onClick={() => {
                    setAuthorId('');
                    drop();
                  }}
                >
                  {t('anyone')}
                </Button>
              </span>
            </Alert>
          ) : null}
        </div>
      ) : null}
      <Card flush>
        <QueryState query={list}>
          <DataTable<Complaint>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty={t(`empty.${view}`)}
            columns={[
              {
                key: 'number',
                header: t('complaint'),
                cell: (c) => (
                  <Link className="table__link t-mono" style={{ whiteSpace: 'nowrap' }} href={`/complaints/${c.id}`}>
                    {c.number}
                  </Link>
                ),
              },
              { key: 'category', header: cm('category'), cell: (c) => (locale === 'ar' ? c.category.nameAr : c.category.nameEn) },
              { key: 'author', header: t('complainant'), cell: (c) => who.person(c.author) },
              {
                key: 'from',
                header: t('fromUnit'),
                cell: (c) => (c.authorUnit ? who.unit(c.authorUnit) : <span className="t-secondary">—</span>),
              },
              { key: 'against', header: t('againstUnit'), cell: (c) => <span className="table__primary">{who.unit(c.targetUnit)}</span> },
              {
                key: 'tally',
                header: t('againstThisUnit'),
                cell: (c) => (
                  <span className="t-num" title={t('tallyTitle')} style={{ whiteSpace: 'nowrap' }}>
                    {t('tallyOpen', { count: f.number(c.againstUnit.open) })} <span className="t-secondary">{t('tallyOf', { count: f.number(c.againstUnit.total) })}</span>
                  </span>
                ),
              },
              {
                key: 'status',
                header: cm('status'),
                cell: (c) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={c.status} />
                    {c.closeReason ? <span className="t-secondary">{label(c.closeReason)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'activity',
                header: t('lastActivity'),
                cell: (c) => (
                  <span title={f.dateTime(c.lastActivityAt)} style={{ whiteSpace: 'nowrap' }}>
                    {f.relative(c.lastActivityAt)}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}

export default function ComplaintsPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
