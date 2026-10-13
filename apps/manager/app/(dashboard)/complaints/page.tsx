'use client';

import { formatDateTime, humanize, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Alert, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { personName } from '@/components/neighbours/bits';
import { emptyText, filtersFor, unitText, VIEW_TEXT, VIEWS, type View } from '@/components/neighbours/logic';
import { UnitPicker } from '@/components/unit-picker';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Complaint, type ComplaintFilters } from '@/lib/queries';

/**
 * Complaints between units (ADR 0042), by last activity. A view narrows by
 * status; the selects narrow by category and by the unit complained about.
 * `?unit=` and `?author=` open the inbox already narrowed, from a
 * complaint's side panels. Every filter is applied by the API, so each page
 * is full.
 */
function Inbox() {
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
        title="Complaints"
        description="What residents report about another unit. The unit complained about never learns who complained: it reads only the management’s notice."
      />
      <div className="toolbar">
        <Segmented<View> label="Complaints shown" value={view} onChange={setView} options={VIEWS.map((value) => ({ value, label: VIEW_TEXT[value] }))} />
        <Field label="Category">
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Any category</option>
              {(categories.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {can('units.read') ? (
          <Field label="Against unit">
            {(p) => <UnitPicker {...p} placeholder="Any unit" style={{ maxWidth: 220 }} value={targetUnitId} onChange={(e) => pickUnit(e.target.value)} />}
          </Field>
        ) : null}
      </div>
      {targetUnitId || authorId ? (
        <div className="stack stack--sm" style={{ marginBottom: 16 }}>
          {targetUnitId ? (
            <Alert>
              <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <span>
                  Against unit <strong>{h ? unitText(h.unit) : '…'}</strong>
                  {h
                    ? `: ${h.history.total} in all · ${h.history.open} open · ${h.history.resolved} resolved · ${h.history.dismissed} dismissed (${h.history.unfounded} as unfounded)`
                    : ''}
                </span>
                <Button size="sm" variant="text" icon={<X aria-hidden />} onClick={() => pickUnit('')}>
                  Any unit
                </Button>
              </span>
            </Alert>
          ) : null}
          {authorId ? (
            <Alert>
              <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <span>
                  Filed by <strong>{author ? personName(author) : 'one complainant'}</strong>
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
                  Anyone
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
            empty={emptyText(view)}
            columns={[
              {
                key: 'number',
                header: 'Complaint',
                cell: (c) => (
                  <Link className="table__link t-mono" style={{ whiteSpace: 'nowrap' }} href={`/complaints/${c.id}`}>
                    {c.number}
                  </Link>
                ),
              },
              { key: 'category', header: 'Category', cell: (c) => c.category.nameEn },
              { key: 'author', header: 'Complainant', cell: (c) => personName(c.author) },
              {
                key: 'from',
                header: 'From unit',
                cell: (c) => (c.authorUnit ? unitText(c.authorUnit) : <span className="t-secondary">—</span>),
              },
              { key: 'against', header: 'Against unit', cell: (c) => <span className="table__primary">{unitText(c.targetUnit)}</span> },
              {
                key: 'tally',
                header: 'Against this unit',
                cell: (c) => (
                  <span className="t-num" title="Complaints against the same unit, this one included" style={{ whiteSpace: 'nowrap' }}>
                    {c.againstUnit.open} open <span className="t-secondary">of {c.againstUnit.total}</span>
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (c) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={c.status} />
                    {c.closeReason ? <span className="t-secondary">{humanize(c.closeReason)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'activity',
                header: 'Last activity',
                cell: (c) => (
                  <span title={formatDateTime(c.lastActivityAt)} style={{ whiteSpace: 'nowrap' }}>
                    {relativeTime(c.lastActivityAt)}
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
